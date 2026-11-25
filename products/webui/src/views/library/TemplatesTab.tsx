/**
 * Templates: the Library's tab of your prompt templates (the Templates list of
 * the Memory and knowledge place, terminal-shell places/memory-place.ts), this
 * project's and every project's, read from the daemon (`template.list` through
 * `capabilities.run`) and read again when one is deleted anywhere (LIST_CHANGED
 * `templates`). See one, or delete one (asked first: it cannot be undone).
 * Using one as your next message, keeping your last message as one and editing
 * one in your editor act on a terminal program's conversation and screen, so
 * their buttons say so here.
 */
import { ActionButtons } from '../../components/command/ActionButtons';
import { ReadState, useCommandRead, useRefreshCommandScreens } from '../../components/command/screens/CommandScreen';
import { Row, RowList } from '../../components/ui/Row';
import { StatusDot } from '../../components/ui/StatusDot';
import { asArray, asRecord } from '../../lib/object';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function TemplatesTab() {
  const read = useCommandRead('library-templates', 'capabilities.run', { id: 'template.list', inputs: {} });
  const refresh = useRefreshCommandScreens();
  const templates = asArray(asRecord(asRecord(read.data).data).templates).map(asRecord).filter((template) => text(template.name));
  return (
    <section className="gv-command-screen" aria-label="Templates" data-testid="library-templates">
      <header className="gv-command-screen__head">
        <div className="gv-command-screen__titles">
          <p className="gv-command-screen__summary">Prompts you keep and use again as a message: this project's and the ones every project shares.</p>
        </div>
        <div className="gv-command-screen__actions">
          <ActionButtons command="template" actions={['save']} onDone={refresh} />
        </div>
      </header>
      <ReadState read={read} isEmpty={templates.length === 0} empty="No templates yet: keep your last message as one in the terminal app, and use it again as a message." />
      {templates.length > 0 ? (
        <RowList aria-label="Templates">
          {templates.map((template) => {
            const name = text(template.name);
            const shared = template.scope === 'global';
            return (
              <Row
                key={`${template.scope}-${name}`}
                leading={<StatusDot tone="ok" srLabel={shared ? 'Every project' : 'This project'} />}
                title={name}
                meta={`${shared ? 'Every project' : template.shadowsGlobal === true ? 'This project (hides the one every project shares)' : 'This project'} · ${text(template.preview) || '(empty)'}`}
                trailing={<ActionButtons command="template" short actions={['show', 'use', 'delete']} menu={['edit']} menuLabel={`More for ${name}`} prefill={{ template: name, scope: shared ? 'global' : 'project' }} onDone={refresh} />}
              />
            );
          })}
        </RowList>
      ) : null}
    </section>
  );
}
