/**
 * Tools and extensions, the web view's skills, skill bundles, published
 * skills, presets and managed settings (terminal-shell
 * places/tools-skills-entries.ts is the same place in the terminal programs).
 * Each is read from the daemon through `capabilities.run` and read again when
 * the daemon says one changed (LIST_CHANGED `tools`, useRealtimeInvalidation.ts).
 * Every button is the capability's sheet, run as the owner's own request; only
 * what cannot be undone or weakens a protection asks first. The browser names
 * no terminal program, so the presets and managed settings shown are the
 * terminal app's own.
 */
import { asArray, asRecord } from '../../../lib/object';
import { Row, RowList } from '../../ui/Row';
import { StatusDot } from '../../ui/StatusDot';
import { ActionButtons } from '../ActionButtons';
import { ReadState, useCommandRead } from './CommandScreen';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}
function when(at: unknown): string {
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : 'not said';
}
const run = (id: string) => ({ id, inputs: {} });
/** A capability's answer: its data. */
const dataOf = (answer: unknown) => asRecord(asRecord(answer).data);
const REVIEW_WORDS: Readonly<Record<string, string>> = { fresh: 'not reviewed yet', reviewed: 'reviewed by you', stale: 'marked out of date' };

function Skills({ onDone }: { readonly onDone: () => void }) {
  const read = useCommandRead('tools-skills', 'capabilities.run', run('my-skills.list'));
  const skills = asArray(dataOf(read.data).skills).map(asRecord).filter((skill) => text(skill.id));
  return (
    <section aria-label="Skills">
      <div className="gv-command-screen__subhead">
        <h4>Skills</h4>
        <ActionButtons command="my-skills" actions={['create', 'import-standard']} menu={['search', 'enabled', 'attention', 'discover']} menuLabel="More about skills" onDone={onDone} />
        <ActionButtons command="skills" actions={['origins']} onDone={onDone} />
      </div>
      <ReadState read={read} isEmpty={skills.length === 0} empty="No skills yet: the model follows no step-by-step procedure of yours." />
      {skills.length > 0 ? (
        <RowList aria-label="Skills">
          {skills.map((skill) => {
            const id = text(skill.id);
            const found = skill.marked !== true;
            const on = skill.enabled === true;
            const review = text(skill.review) || 'fresh';
            const ready = skill.ready !== false;
            const primary = found ? ['import-discovered'] : [on ? 'disable' : 'enable', ...(review === 'reviewed' ? [] : ['review'])];
            return (
              <Row
                key={id}
                leading={<StatusDot tone={found ? 'idle' : on && !ready ? 'warn' : on ? 'ok' : 'idle'} srLabel={found ? 'Found on disk' : on ? 'On' : 'Off'} />}
                title={text(skill.name) || id}
                meta={[
                  text(skill.description),
                  found ? 'a skill file found on disk, not taken in yet' : on ? 'switched on' : 'switched off',
                  ...(found ? [] : [REVIEW_WORDS[review] ?? review]),
                  ...(on && !ready ? [`needs ${asArray(skill.missing).map(text).join(', ')}`] : []),
                ].filter(Boolean).join(' · ')}
                trailing={(
                  <>
                    <ActionButtons command="my-skills" short actions={primary} menu={['show', 'update', 'stale', 'export-standard', 'delete']} menuLabel={`More for ${text(skill.name) || id}`} prefill={found ? { file: id } : { skill: id }} onDone={onDone} />
                    <ActionButtons command="skills" short actions={[]} menu={['show']} menuLabel={`Where ${text(skill.name) || id} is`} prefill={{ skill: id }} onDone={onDone} />
                  </>
                )}
              />
            );
          })}
        </RowList>
      ) : null}
    </section>
  );
}

function Bundles({ onDone }: { readonly onDone: () => void }) {
  const read = useCommandRead('tools-skill-bundles', 'capabilities.run', run('my-skills.bundles'));
  const bundles = asArray(dataOf(read.data).bundles).map(asRecord).filter((bundle) => text(bundle.id));
  return (
    <section aria-label="Skill bundles">
      <div className="gv-command-screen__subhead">
        <h4>Skill bundles</h4>
        <ActionButtons command="my-skills" actions={['bundle-create']} menu={['bundle-search', 'bundles-enabled', 'bundles-attention']} menuLabel="More about skill bundles" onDone={onDone} />
      </div>
      <ReadState read={read} isEmpty={bundles.length === 0} empty="No skill bundles yet: a bundle puts several skills to use together." />
      {bundles.length > 0 ? (
        <RowList aria-label="Skill bundles">
          {bundles.map((bundle) => {
            const id = text(bundle.id);
            const on = bundle.enabled === true;
            const review = text(bundle.review) || 'fresh';
            return (
              <Row
                key={id}
                leading={<StatusDot tone={on && bundle.ready === false ? 'warn' : on ? 'ok' : 'idle'} srLabel={on ? 'On' : 'Off'} />}
                title={text(bundle.name) || id}
                meta={[text(bundle.description), `skills ${asArray(bundle.skillIds).map(text).join(', ')}`, on ? 'switched on' : 'switched off', REVIEW_WORDS[review] ?? review].filter(Boolean).join(' · ')}
                trailing={<ActionButtons command="my-skills" short actions={[on ? 'bundle-disable' : 'bundle-enable', ...(review === 'reviewed' ? [] : ['bundle-review'])]} menu={['bundle-show', 'bundle-update', 'bundle-stale', 'bundle-delete']} menuLabel={`More for ${text(bundle.name) || id}`} prefill={{ bundle: id }} onDone={onDone} />}
              />
            );
          })}
        </RowList>
      ) : null}
    </section>
  );
}

function Published({ onDone }: { readonly onDone: () => void }) {
  const read = useCommandRead('tools-published', 'capabilities.run', run('skills.list'));
  const published = asArray(dataOf(read.data).published).map(asRecord).filter((entry) => text(entry.id));
  return (
    <section aria-label="Published skills">
      <div className="gv-command-screen__subhead">
        <h4>Published skills</h4>
        <ActionButtons command="skills" actions={['publish-local']} onDone={onDone} />
      </div>
      <ReadState read={read} isEmpty={published.length === 0} empty="Nothing published to the local catalog." />
      {published.length > 0 ? (
        <RowList aria-label="Published skills">
          {published.map((entry) => (
            <Row
              key={text(entry.id)}
              leading={<StatusDot tone="ok" srLabel="Published" />}
              title={text(entry.name) || text(entry.id)}
              meta={[text(entry.summary), text(entry.source)].filter(Boolean).join(' · ')}
              trailing={<ActionButtons command="skills" short actions={['unpublish']} prefill={{ id: text(entry.id) }} onDone={onDone} />}
            />
          ))}
        </RowList>
      ) : null}
    </section>
  );
}

function Presets({ onDone }: { readonly onDone: () => void }) {
  const read = useCommandRead('tools-presets', 'capabilities.run', run('presets.list'));
  const presets = asArray(dataOf(read.data).presets).map(asRecord).filter((preset) => text(preset.id));
  return (
    <section aria-label="Presets">
      <div className="gv-command-screen__subhead">
        <h4>Presets</h4>
        <ActionButtons command="presets" actions={['save']} menu={['export', 'inspect', 'import']} menuLabel="More about presets" onDone={onDone} />
      </div>
      <ReadState read={read} isEmpty={presets.length === 0} empty="No presets yet: save your display, model and behaviour settings as one." />
      {presets.length > 0 ? (
        <RowList aria-label="Presets">
          {presets.map((preset) => {
            const id = text(preset.id);
            return (
              <Row
                key={id}
                leading={<StatusDot tone="ok" srLabel="Saved" />}
                title={text(preset.name) || id}
                meta={`saved ${when(preset.savedAt)}`}
                trailing={(
                  <>
                    <ActionButtons command="presets" short actions={['load']} menu={['delete']} menuLabel={`More for ${id}`} prefill={{ preset: id }} onDone={onDone} />
                    <ActionButtons command="managed" short actions={[]} menu={['export']} menuLabel={`Save ${id} as a managed bundle`} prefill={{ profile: id }} onDone={onDone} />
                  </>
                )}
              />
            );
          })}
        </RowList>
      ) : null}
    </section>
  );
}

function Managed({ onDone }: { readonly onDone: () => void }) {
  const read = useCommandRead('tools-managed', 'capabilities.run', run('managed.review'));
  const data = dataOf(read.data);
  const staged = asArray(data.staged).map(asRecord).filter((entry) => text(entry.id));
  const locks = asArray(data.locks).map(asRecord).filter((entry) => text(entry.id));
  const applies = asArray(data.rollbacks).map(asRecord).filter((entry) => text(entry.id));
  const empty = staged.length === 0 && locks.length === 0 && applies.length === 0;
  return (
    <section aria-label="Managed settings">
      <div className="gv-command-screen__subhead">
        <h4>Managed settings</h4>
        <ActionButtons command="managed" actions={['stage', 'apply']} menu={['inspect', 'lock', 'history']} menuLabel="More about managed settings" onDone={onDone} />
      </div>
      <ReadState read={read} isEmpty={empty} empty="No managed settings: nothing is staged or locked, and no apply waits to be rolled back." />
      {!empty ? (
        <RowList aria-label="Managed settings">
          {staged.map((entry) => (
            <Row
              key={`staged:${text(entry.id)}`}
              leading={<StatusDot tone="warn" srLabel="Staged" />}
              title={`Staged: ${text(entry.name) || 'a bundle'}`}
              meta={[text(entry.path), `${text(entry.changes) || '0'} change(s), risk ${text(entry.risk) || 'not said'}`].filter(Boolean).join(' · ')}
              trailing={<ActionButtons command="managed" short actions={['apply-staged']} menu={['staged']} menuLabel="More for the staged bundle" onDone={onDone} />}
            />
          ))}
          {locks.map((entry) => (
            <Row
              key={`lock:${text(entry.id)}`}
              leading={<StatusDot tone="idle" srLabel="Locked" />}
              title={`Locked: ${text(entry.key)}`}
              meta={[`managed by ${text(entry.source) || 'not said'}`, text(entry.reason), `since ${when(entry.at)}`].filter(Boolean).join(' · ')}
              trailing={<ActionButtons command="managed" short actions={['unlock']} prefill={{ key: text(entry.key) }} onDone={onDone} />}
            />
          ))}
          {applies.map((entry) => (
            <Row
              key={`applied:${text(entry.id)}`}
              leading={<StatusDot tone="ok" srLabel="Applied" />}
              title={`Applied: ${text(entry.name) || 'a bundle'}`}
              meta={[when(entry.at), text(entry.path), `${text(entry.settings) || '0'} setting(s)`].filter(Boolean).join(' · ')}
              trailing={<ActionButtons command="managed" short actions={['rollback']} prefill={{ token: text(entry.id) }} onDone={onDone} />}
            />
          ))}
        </RowList>
      ) : null}
    </section>
  );
}

/** The sections, in the place's order, for the Tools and extensions screen. */
export function ToolsSkillsSections({ onDone }: { readonly onDone: () => void }) {
  return (
    <>
      <Skills onDone={onDone} />
      <Bundles onDone={onDone} />
      <Published onDone={onDone} />
      <Presets onDone={onDone} />
      <Managed onDone={onDone} />
    </>
  );
}
