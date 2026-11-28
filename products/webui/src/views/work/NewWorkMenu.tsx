/**
 * The Work page's one primary action: "New", a menu of what can be started
 * from here, each in a kit Dialog, named by what it gets done. Work
 * (work.delegate through capabilities.run, always a piece of Work), task
 * (tasks.create), session in a folder (sessions.hosted.create, offered only the
 * folders sessions.hosted.workspaces names; the detach policy defaults to the
 * daemon's own setting and is omitted from the call unless chosen; the
 * assistant is the daemon's own unless GoodVibes Agent is chosen, which sends
 * `originSurface: 'agent'` so the session runs as an Agent turn), CI watch
 * (ci.watches.create), and a one-off CI status check (ci.status) that creates
 * nothing.
 */
import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronDown, GitBranch, ListTodo, Plus, Search, Server } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import type { SessionsHostedCreateInput } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { hostedSessionFromResult } from '../../lib/hosted-sessions';
import { formatError, isMethodUnavailableError, isSessionClosedError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Menu, MenuItem } from '../../components/ui/Menu';
import { Select } from '../../components/ui/Select';
import { CiReportDetail, type CiReport } from './CiWatchDetail';
import { CapabilityRunner } from '../places/CapabilityRunner';
import { projectChoiceLabel, usePlaceProjects } from '../../lib/place-project';
import { resolvePlaceCapability, runPlaceCapability, useCapabilityIndex } from '../../lib/place-capabilities';

type NewKind = 'native' | 'task' | 'hosted' | 'ci-watch' | 'ci-status';

export interface NewWorkMenuProps {
  /** A created item to open: its Work key (`hosted:<id>`, ...). */
  onCreated: (key: string) => void;
  /** Open the schedules screen (the Scheduled group's own management). */
  onSchedules?: () => void;
}

/**
 * New work, as the owner asks for it: what they want done and, if they say, what done means. It is the daemon's own
 * hand-over (`work.delegate`, the act a terminal program's New work and a model's hand-off reach), run as their request
 * for the project they chose, so it is always a piece of Work: never a conversation turn a model may answer instead.
 */
function WorkRequestForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const places = usePlaceProjects();
  const [goal, setGoal] = useState('');
  const [criteria, setCriteria] = useState('');
  const [chosen, setChosen] = useState('');
  const folders = places.projects;
  const project = chosen || (places.project && places.project.startsWith('/') ? places.project : folders[0]) || '';
  const create = useMutation({
    mutationFn: () => runPlaceCapability('work.delegate', { goal: goal.trim(), criteria: criteria.trim() }, project),
    onSuccess: async (answer) => {
      setGoal('');
      setCriteria('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      toast({ title: answer.text || 'The work is asked for; it shows in Work.', tone: 'success' });
      onDone();
    },
    onError: (error: unknown) => toast({ title: 'The work was not asked for', description: formatError(error), tone: 'danger' }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (goal.trim() && project && !create.isPending) create.mutate();
  };
  return (
    <form className="work-form" onSubmit={submit}>
      <Field label="What you want done" help="In your own words: it becomes a piece of work, planned and run on the daemon.">
        <Textarea autoFocus rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} disabled={create.isPending} />
      </Field>
      <Field label="Done when (optional)" help="The results that mean it is done, one per line. Left empty, it is done when it is done as asked.">
        <Textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} disabled={create.isPending} />
      </Field>
      {folders.length > 1 ? (
        <Field label="Project">
          <Select aria-label="Project" value={project} onChange={setChosen} disabled={create.isPending}
            options={folders.map((root) => ({ value: root, label: projectChoiceLabel(places, root, root) }))} />
        </Field>
      ) : null}
      {places.status !== 'reading' && !project ? <p role="alert">The daemon names no project to do work in.</p> : null}
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={!goal.trim() || !project || create.isPending}>
          {create.isPending ? 'Asking…' : 'Ask for it'}
        </Button>
      </div>
    </form>
  );
}

function TaskForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [task, setTask] = useState('');
  const create = useMutation({
    mutationFn: () => platformClient.operator.tasks.create({ task: task.trim() }),
    onSuccess: async () => {
      setTask('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      toast({ title: 'Task submitted', tone: 'success' });
      onDone();
    },
    onError: (error: unknown) => toast({
      title: 'Failed to submit task',
      description: isSessionClosedError(error) ? 'That session is closed.' : formatError(error),
      tone: 'danger',
    }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (task.trim() && !create.isPending) create.mutate();
  };
  return (
    <form id="work-new-form" className="work-form" onSubmit={submit}>
      <Field label="Task" help="The daemon queues it and runs it in the background.">
        <Input
          autoFocus
          placeholder="Describe a task to submit"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          disabled={create.isPending}
        />
      </Field>
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={!task.trim() || create.isPending}>
          {create.isPending ? 'Submitting…' : 'Submit'}
        </Button>
      </div>
    </form>
  );
}

function HostedForm({ onDone }: { onDone: (key?: string) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [title, setTitle] = useState('');
  // The daemon decides which folders work may run in; the form offers exactly those.
  const roots = useQuery({
    queryKey: ['sessions', 'hosted', 'workspaces'] as const,
    queryFn: () => platformClient.operator.sessions.hosted.workspaces(),
    retry: false,
  });
  const offered = roots.data?.roots ?? [];
  const chosenRoot = workspaceRoot || offered[0] || '';
  const [detachPolicy, setDetachPolicy] = useState<'' | 'kill' | 'survive'>('');
  const [assistant, setAssistant] = useState<'' | 'agent'>('');
  const create = useMutation({
    mutationFn: (input: SessionsHostedCreateInput) => platformClient.operator.sessions.hosted.create(input),
    onSuccess: (result) => {
      const session = hostedSessionFromResult(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedSessionsAll });
      if (!session) {
        toast({ title: 'Hosted session created', description: 'The daemon did not return a session in a shape this client understands; refresh to find it.', tone: 'info' });
        onDone();
        return;
      }
      toast({ title: 'Hosted session created', tone: 'success' });
      onDone(`hosted:${session.id}`);
    },
    onError: (error: unknown) => toast({ title: 'Could not create hosted session', description: formatError(error), tone: 'danger' }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const root = chosenRoot.trim();
    if (!root || create.isPending) return;
    create.mutate({
      workspaceRoot: root,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(detachPolicy ? { detachPolicy } : {}),
      ...(assistant ? { originSurface: assistant } : {}),
    });
  };
  return (
    <form className="work-form" onSubmit={submit}>
      {offered.length > 0 ? (
        <Field label="Folder" help="The daemon's own folder and the projects registered with it. Register another project from the terminal app to add it here.">
          <Select
            aria-label="Folder"
            value={chosenRoot}
            onChange={setWorkspaceRoot}
            disabled={create.isPending}
            options={offered.map((root) => ({ value: root, label: root }))}
          />
        </Field>
      ) : (
        <Field label="Folder path" help={roots.isPending ? 'Loading the folders this daemon allows…' : 'An absolute path on the daemon\'s machine.'}>
          <Input autoFocus required placeholder="/home/you/project" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} disabled={create.isPending} />
        </Field>
      )}
      <Field label="Title (optional)">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={create.isPending} />
      </Field>
      <Field label="Assistant" help="GoodVibes Agent answers with the Agent's own policy, persona, skills, memory and the Agent tools that need no terminal; a tool that runs only in the Agent's terminal is refused there, with that said.">
        <Select<'' | 'agent'>
          aria-label="Assistant"
          value={assistant}
          onChange={setAssistant}
          disabled={create.isPending}
          options={[
            { value: '', label: 'Daemon session' },
            { value: 'agent', label: 'GoodVibes Agent' },
          ]}
        />
      </Field>
      <Field label="When the last client leaves">
        <Select<'' | 'kill' | 'survive'>
          aria-label="Detach policy"
          value={detachPolicy}
          onChange={setDetachPolicy}
          disabled={create.isPending}
          options={[
            { value: '', label: 'Use the daemon default' },
            { value: 'kill', label: 'End the session' },
            { value: 'survive', label: 'Keep it running' },
          ]}
        />
      </Field>
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={create.isPending || !chosenRoot.trim()}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}

function CiWatchForm({ onDone }: { onDone: (key?: string) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [deliveryChannel, setDeliveryChannel] = useState('');
  const [triggerFixSession, setTriggerFixSession] = useState(false);
  const create = useMutation({
    mutationFn: () => platformClient.operator.ci.watches.create({
      repo: repo.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(prNumber.trim() ? { prNumber: Number(prNumber.trim()) } : {}),
      deliveryChannel: deliveryChannel.trim(),
      triggerFixSession,
    }),
    onSuccess: async (result) => {
      toast({ title: 'Watch created', tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.ciWatches });
      const id = (result as { watch?: { id?: unknown } } | undefined)?.watch?.id;
      onDone(typeof id === 'string' ? `ci-watch:${id}` : undefined);
    },
    onError: (error: unknown) => toast({ title: 'Failed to create watch', description: formatError(error), tone: 'danger' }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!repo.trim() || !deliveryChannel.trim() || create.isPending) return;
    create.mutate();
  };
  return (
    <form className="work-form" onSubmit={submit}>
      <Field label="Repository">
        <Input autoFocus required placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={create.isPending} />
      </Field>
      <div className="work-form__pair">
        <Field label="Ref (optional)">
          <Input placeholder="main" value={ref} onChange={(e) => setRef(e.target.value)} disabled={create.isPending} />
        </Field>
        <Field label="Pull request (optional)">
          <Input inputMode="numeric" pattern="[0-9]*" placeholder="123" value={prNumber} onChange={(e) => setPrNumber(e.target.value.replace(/\D/g, ''))} disabled={create.isPending} />
        </Field>
      </div>
      <Field label="Delivery channel" help="Where the result is sent, for example a Slack channel.">
        <Input required value={deliveryChannel} onChange={(e) => setDeliveryChannel(e.target.value)} disabled={create.isPending} />
      </Field>
      <Checkbox checked={triggerFixSession} onChange={setTriggerFixSession} disabled={create.isPending}>
        Start a fix session on failure
      </Checkbox>
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={create.isPending || !repo.trim() || !deliveryChannel.trim()}>
          {create.isPending ? 'Creating…' : 'Create watch'}
        </Button>
      </div>
    </form>
  );
}

function CiStatusForm() {
  const { toast } = useToast();
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [report, setReport] = useState<CiReport | null>(null);
  const check = useMutation({
    mutationFn: () => platformClient.operator.ci.status({
      repo: repo.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(prNumber.trim() ? { prNumber: Number(prNumber.trim()) } : {}),
    }),
    onSuccess: (result) => setReport(result.report),
    onError: (error: unknown) => toast({
      title: isMethodUnavailableError(error) ? 'CI status unavailable on this daemon' : 'Check failed',
      description: isMethodUnavailableError(error) ? undefined : formatError(error),
      tone: 'danger',
    }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (repo.trim() && !check.isPending) check.mutate();
  };
  return (
    <form className="work-form" onSubmit={submit}>
      <Field label="Repository">
        <Input autoFocus required placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={check.isPending} />
      </Field>
      <div className="work-form__pair">
        <Field label="Ref (optional)">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} disabled={check.isPending} />
        </Field>
        <Field label="Pull request (optional)">
          <Input inputMode="numeric" pattern="[0-9]*" value={prNumber} onChange={(e) => setPrNumber(e.target.value.replace(/\D/g, ''))} disabled={check.isPending} />
        </Field>
      </div>
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={check.isPending || !repo.trim()}>
          {check.isPending ? 'Checking…' : 'Check status'}
        </Button>
      </div>
      {report && <CiReportDetail report={report} />}
    </form>
  );
}

const TITLES: Record<NewKind, { title: string; description: string }> = {
  native: { title: 'Ask for work to be done', description: 'Describe what you want; the daemon carries it through and shows its progress here.' },
  task: { title: 'Run a background task', description: 'A one-off task the daemon runs on its own, with no conversation.' },
  hosted: { title: 'Start a session in a folder', description: 'A conversation that runs inside the daemon in one of its folders and keeps going when this tab closes.' },
  'ci-watch': { title: 'Watch CI', description: 'Get notified when a repository, ref or pull request finishes its checks.' },
  'ci-status': { title: 'Check CI status', description: 'Look up any repository, ref or pull request once, without creating a watch.' },
};

export function NewWorkMenu({ onCreated, onSchedules }: NewWorkMenuProps) {
  const [open, setOpen] = useState<NewKind | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const capabilities = useCapabilityIndex();
  const addSchedule = (capabilities ? resolvePlaceCapability(capabilities, 'schedule.add')?.action.label : undefined) ?? 'Add a schedule';
  const seeSchedules = 'See schedules';
  const close = () => setOpen(null);
  const done = (key?: string) => {
    setOpen(null);
    if (key) onCreated(key);
  };
  return (
    <>
      <Menu
        label="New"
        placement="bottom-end"
        trigger={(props) => (
          <Button {...props} variant="primary" icon={<Plus aria-hidden="true" />}>
            New
            <ChevronDown className="work-new__chevron" aria-hidden="true" />
          </Button>
        )}
      >
        <MenuItem icon={<ListTodo />} onSelect={() => setOpen('native')}>Ask for work to be done</MenuItem>
        <MenuItem icon={<ListTodo />} onSelect={() => setOpen('task')}>Run a background task</MenuItem>
        <MenuItem icon={<Server />} onSelect={() => setOpen('hosted')}>Start a session in a folder</MenuItem>
        <MenuItem icon={<GitBranch />} onSelect={() => setOpen('ci-watch')}>CI watch</MenuItem>
        <MenuItem icon={<Search />} onSelect={() => setOpen('ci-status')}>Check CI status</MenuItem>
        <MenuItem icon={<CalendarClock />} onSelect={() => setScheduling(true)}>{addSchedule}…</MenuItem>
        {onSchedules ? <MenuItem icon={<CalendarClock />} onSelect={onSchedules}>{seeSchedules}</MenuItem> : null}
      </Menu>
      {scheduling ? <CapabilityRunner id="schedule.add" onClose={() => setScheduling(false)} /> : null}
      <Dialog
        open={open !== null}
        onClose={close}
        title={open ? TITLES[open].title : ''}
        description={open ? TITLES[open].description : undefined}
      >
        {open === 'native' && <WorkRequestForm onDone={() => done()} />}
        {open === 'task' && <TaskForm onDone={() => done()} />}
        {open === 'hosted' && <HostedForm onDone={done} />}
        {open === 'ci-watch' && <CiWatchForm onDone={done} />}
        {open === 'ci-status' && <CiStatusForm />}
      </Dialog>
    </>
  );
}
