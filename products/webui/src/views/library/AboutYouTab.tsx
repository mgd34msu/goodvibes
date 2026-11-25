/**
 * About you: the Library's tab of what GoodVibes knows about you (the About you
 * list of the Memory and knowledge place, terminal-shell places/memory-place.ts).
 * Your profile as the daemon reads it (`profile.read`), read again when it says
 * the profile changed (LIST_CHANGED `profile`, useRealtimeInvalidation.ts): each
 * fact with its value and where it came from, each line of a section, and the
 * people you named. Every button is an "about you" capability's sheet
 * (capabilities/builtin/profile.ts), run through `capabilities.run` as the
 * owner's own request; forgetting asks first, because it cannot be undone. A
 * profile that cannot be read says so, never that nothing is known.
 */
import { ActionButtons } from '../../components/command/ActionButtons';
import { ReadState, useCommandRead, useRefreshCommandScreens } from '../../components/command/screens/CommandScreen';
import { Row, RowList } from '../../components/ui/Row';
import { StatusDot } from '../../components/ui/StatusDot';
import { asArray, asRecord } from '../../lib/object';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function origin(value: unknown): string {
  const from = asRecord(value);
  return text(from.surface) ? `From ${text(from.surface)} on ${text(from.date)}: you said "${text(from.said)}"` : 'Written by hand';
}

export function AboutYouTab() {
  const read = useCommandRead('library-about-you', 'profile.read');
  const refresh = useRefreshCommandScreens();
  const document = asRecord(read.data);
  const state = asRecord(document.state);
  const sections = asArray(document.sections).map(asRecord);
  const empty = sections.every((section) => asArray(section.fields).length === 0 && asArray(section.prose).length === 0);
  return (
    <section className="gv-command-screen" aria-label="About you" data-testid="library-about-you">
      <header className="gv-command-screen__head">
        <div className="gv-command-screen__titles">
          <p className="gv-command-screen__summary">What GoodVibes knows about you, each fact with where it came from. You can correct it, put an earlier value back, or forget it.</p>
        </div>
        <div className="gv-command-screen__actions">
          <ActionButtons command="about-me" actions={['set', 'note']} menu={['person', 'status']} menuLabel="More about you" primary onDone={refresh} />
        </div>
      </header>
      <ReadState read={read} isEmpty={false} empty="" />
      {state.kind === 'unavailable' ? (
        <p className="gv-command-screen__state" role="alert">Your profile could not be read: {text(state.reason) || 'no reason given'} ({text(state.path)}).</p>
      ) : state.kind === 'disabled' ? (
        <p className="gv-command-screen__state">Your profile is turned off ({text(state.path)}).</p>
      ) : read.data && empty ? (
        <p className="gv-command-screen__state">Nothing is known about you yet: record a fact or add a line about you.</p>
      ) : null}
      {state.kind !== 'unavailable' && state.kind !== 'disabled' ? sections.map((section) => {
        const heading = text(section.heading);
        const fields = asArray(section.fields).map(asRecord);
        const lines = asArray(section.prose).map(asRecord);
        if (fields.length === 0 && lines.length === 0) return null;
        return (
          <section key={heading} aria-label={heading}>
            <div className="gv-command-screen__subhead"><h4>{heading}</h4></div>
            <RowList aria-label={heading}>
              {fields.map((field) => {
                const id = text(field.fieldId);
                const invalid = field.valid === false;
                return (
                  <Row
                    key={id}
                    leading={<StatusDot tone={invalid ? 'warn' : 'ok'} srLabel={invalid ? 'Did not parse' : 'Recorded'} />}
                    title={`${text(field.label) || id}: ${text(field.value)}`}
                    meta={invalid ? `It did not parse (${text(field.invalidReason) || 'no reason given'}); kept as written, treated as unset` : origin(field.provenance)}
                    trailing={<ActionButtons command="about-me" short actions={['set', 'undo', 'forget']} menu={['where']} menuLabel={`More for ${text(field.label) || id}`} prefill={{ field: id }} onDone={refresh} />}
                  />
                );
              })}
              {lines.map((line, index) => (
                <Row
                  key={`${index}-${text(line.text)}`}
                  leading={<StatusDot tone="ok" srLabel="Recorded" />}
                  title={text(line.text)}
                  meta={origin(line.provenance)}
                  trailing={<ActionButtons command="about-me" short actions={['forget-line']} prefill={{ section: heading, line: text(line.text) }} onDone={refresh} />}
                />
              ))}
            </RowList>
          </section>
        );
      }) : null}
    </section>
  );
}
