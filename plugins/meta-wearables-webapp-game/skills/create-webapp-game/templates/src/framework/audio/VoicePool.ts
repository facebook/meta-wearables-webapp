/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * VoicePool — the bookkeeping half of the voice system, with no Web Audio in it.
 *
 * AudioEngine owns the actual nodes; this owns the answer to "may this play start,
 * and what has to die first?". Splitting it out keeps the concurrency rules — the
 * part with the fiddly edge cases — unit-testable in plain Node, with no
 * AudioContext and no jsdom.
 *
 * A voice belongs to one or more *voice groups*, identified by opaque strings. The
 * pool never learns what a group means; AmpAudioManager decides that a group is an
 * event (or a budget shared between several events). Each group carries a limit and
 * a rule for what happens when that limit is reached:
 *
 *   killOldest  — evict the longest-running voice in the group to make room
 *   preventNew  — refuse the new voice and leave the group untouched
 *
 * Voices marked `stopping` (fading out) stop counting against group limits right
 * away, so retriggering an event crossfades with its own outgoing tail instead of
 * being blocked by it. They do still occupy a global slot until the node ends, and
 * they are the first thing the global cap reclaims.
 */

/** Opaque handle to a playing voice. */
export type VoiceHandle = number;

/** What to do when a voice group is already at its limit. */
export type VoiceLimitStrategy = 'killOldest' | 'preventNew';

/** One concurrency budget a play must satisfy. */
export interface VoiceConstraint {
  /** Opaque group id. The pool only ever compares these for equality. */
  groupId: string;
  /** Max concurrent non-fading voices in the group. Always >= 1. */
  limit: number;
  strategy: VoiceLimitStrategy;
}

/** The pool's verdict on a requested play. */
export interface AdmitPlan {
  /** False when some group said `preventNew`; `evict` is empty in that case. */
  admitted: boolean;
  /** Handles the caller must hard-stop before starting the new voice. */
  evict: VoiceHandle[];
}

interface PooledVoice {
  handle: VoiceHandle;
  groups: string[];
  loop: boolean;
  stopping: boolean;
}

export class VoicePool {
  private _voices = new Map<VoiceHandle, PooledVoice>();
  /** Insertion-ordered handles. Position in here defines "oldest". */
  private _order: VoiceHandle[] = [];
  /** groupId -> handles, insertion-ordered. Empty groups are pruned. */
  private _groups = new Map<string, VoiceHandle[]>();

  /** Every live voice, fading ones included. */
  get size(): number {
    return this._order.length;
  }

  has(handle: VoiceHandle): boolean {
    return this._voices.has(handle);
  }

  /** Group ids with at least one live voice. */
  get activeGroupIds(): string[] {
    return [...this._groups.keys()];
  }

  /** Voices in a group that still count against its limit (i.e. not fading out). */
  countInGroup(groupId: string): number {
    return this._countInGroupExcluding(groupId, EMPTY_SET);
  }

  /** Every live handle in the group, fading ones included. */
  handlesInGroup(groupId: string): VoiceHandle[] {
    return [...(this._groups.get(groupId) ?? [])];
  }

  /**
   * Decide whether a new voice may start, and which existing voices must be
   * hard-stopped first. Pure: nothing is mutated, so a caller that bails out after
   * calling this leaves the pool untouched.
   */
  plan(constraints: readonly VoiceConstraint[], globalLimit: number): AdmitPlan {
    // A single `preventNew` group vetoes the play outright, so check every group
    // before evicting anything — otherwise we would kill voices to make room for a
    // play we are about to refuse anyway.
    for (const constraint of constraints) {
      const limit = Math.max(1, constraint.limit);
      if (
        constraint.strategy === 'preventNew' &&
        this.countInGroup(constraint.groupId) >= limit
      ) {
        return { admitted: false, evict: [] };
      }
    }

    const evict: VoiceHandle[] = [];
    const evicted = new Set<VoiceHandle>();

    for (const constraint of constraints) {
      const limit = Math.max(1, constraint.limit);
      // Room for the incoming voice means getting down to limit - 1.
      while (this._countInGroupExcluding(constraint.groupId, evicted) >= limit) {
        const victim = this._oldestCountedInGroup(constraint.groupId, evicted);
        if (victim === undefined) break;
        evicted.add(victim);
        evict.push(victim);
      }
    }

    // The global cap counts every live node, fading tails included, because those
    // still cost CPU on the audio render thread.
    const cap = Math.max(1, globalLimit);
    let occupancy = this._order.length - evicted.size;
    while (occupancy >= cap) {
      const victim = this._globalVictim(evicted);
      if (victim === undefined) break;
      evicted.add(victim);
      evict.push(victim);
      occupancy--;
    }

    return { admitted: true, evict };
  }

  /** Record a started voice. `groups` may be empty. */
  add(handle: VoiceHandle, groups: readonly string[], loop: boolean): void {
    const unique = [...new Set(groups)];
    this._voices.set(handle, { handle, groups: unique, loop, stopping: false });
    this._order.push(handle);
    for (const groupId of unique) {
      const handles = this._groups.get(groupId);
      if (handles) {
        handles.push(handle);
      } else {
        this._groups.set(groupId, [handle]);
      }
    }
  }

  /** Forget a voice that has ended. Safe to call twice. */
  remove(handle: VoiceHandle): void {
    const voice = this._voices.get(handle);
    if (!voice) return;
    this._voices.delete(handle);

    const orderIndex = this._order.indexOf(handle);
    if (orderIndex !== -1) this._order.splice(orderIndex, 1);

    for (const groupId of voice.groups) {
      const handles = this._groups.get(groupId);
      if (!handles) continue;
      const index = handles.indexOf(handle);
      if (index !== -1) handles.splice(index, 1);
      // Prune, or the map accumulates a key per event name for the whole session.
      if (handles.length === 0) this._groups.delete(groupId);
    }
  }

  /** Mark a voice as fading out: it stops counting against group limits at once. */
  markStopping(handle: VoiceHandle): void {
    const voice = this._voices.get(handle);
    if (voice) voice.stopping = true;
  }

  isStopping(handle: VoiceHandle): boolean {
    return this._voices.get(handle)?.stopping ?? false;
  }

  /** Live handles, oldest first. */
  handles(): VoiceHandle[] {
    return [...this._order];
  }

  clear(): void {
    this._voices.clear();
    this._order.length = 0;
    this._groups.clear();
  }

  // ---- Internals -----------------------------------------------------------

  private _countInGroupExcluding(groupId: string, excluded: ReadonlySet<VoiceHandle>): number {
    const handles = this._groups.get(groupId);
    if (!handles) return 0;
    let count = 0;
    for (const handle of handles) {
      if (excluded.has(handle)) continue;
      if (this._voices.get(handle)?.stopping) continue;
      count++;
    }
    return count;
  }

  /**
   * Oldest voice in the group that still counts. Fading voices are skipped: taking
   * one would not lower the count, and the while-loop above would never terminate.
   */
  private _oldestCountedInGroup(
    groupId: string,
    excluded: ReadonlySet<VoiceHandle>,
  ): VoiceHandle | undefined {
    for (const handle of this._order) {
      if (excluded.has(handle)) continue;
      const voice = this._voices.get(handle);
      if (!voice || voice.stopping) continue;
      if (voice.groups.includes(groupId)) return handle;
    }
    return undefined;
  }

  /**
   * Victim for the global cap: something already fading if possible, otherwise the
   * oldest one-shot, otherwise the oldest voice. One-shots are preferred over loops
   * so ambience survives a burst of gameplay sounds.
   */
  private _globalVictim(excluded: ReadonlySet<VoiceHandle>): VoiceHandle | undefined {
    let oldestNonLoop: VoiceHandle | undefined;
    let oldest: VoiceHandle | undefined;

    for (const handle of this._order) {
      if (excluded.has(handle)) continue;
      const voice = this._voices.get(handle);
      if (!voice) continue;
      if (voice.stopping) return handle;
      if (oldest === undefined) oldest = handle;
      if (!voice.loop && oldestNonLoop === undefined) oldestNonLoop = handle;
    }
    return oldestNonLoop ?? oldest;
  }
}

const EMPTY_SET: ReadonlySet<VoiceHandle> = new Set<VoiceHandle>();
