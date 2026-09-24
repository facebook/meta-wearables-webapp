import {useState} from 'react';
import {
  App as WearablesApp,
  Button,
  ButtonRail,
  Page,
  Panel,
  ScrollView,
  TextStyle,
  TextView,
} from '@wearables-ui-toolkit/mrbd';

export default function App() {
  const [active, setActive] = useState(false);

  return (
    <WearablesApp>
      <Page headerText="New App" enableSystemBarInset={false}>
        <div className="action-page-shell">
          <ScrollView insetForHeader ariaLabel="Application content" tabIndex={0}>
            <Panel width="100%">
              <div className="content-inset">
                <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED}>
                  {active ? 'Session is active.' : 'Session is ready.'}
                </TextView>
                <TextView as="p" textStyle={TextStyle.BODY2}>
                  Replace this starter session with one focused glasses experience.
                </TextView>
              </div>
            </Panel>
          </ScrollView>
          <div className="action-dock">
            <ButtonRail>
              <Button
                title={active ? 'Pause' : 'Start'}
                onClick={() => setActive(current => !current)}
              />
            </ButtonRail>
          </div>
        </div>
      </Page>
    </WearablesApp>
  );
}
