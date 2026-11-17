# Occasions and plans

The daemon holds durable facts about the owner's life, a partner's birthday,
an anniversary, a friend's birthday, and **raises them on its own, before they
matter**, without being asked. It remembers the owner's answer so it does not
keep asking, but not forever, because the occasions recur.

The design contract, in requirements form:

- The agent knows an occasion is approaching and proactively suggests acting
  on it. It does not need to recommend a specific gift; it needs to surface
  that something needs to happen, ahead of the date.
- A yes or no is remembered so the same occasion is not raised again, and
  that memory expires on the occasion's own cycle, because an annual date
  comes back.
- Stated plans (a trip with dates and a destination) are captured the same
  way and recalled when they become relevant.

---

## 1. Two things, not one

They behave differently and share no code path beyond storage.

**Occasions.** Dated, usually recurring, and they *need an action*. Birthdays,
anniversaries. These prompt, and they remember the answer.

**Plans.** A dated range with attributes, ambient rather than prompting.
"Vacation, 12–19 September, Lisbon." There is nothing to decide; the system just
needs to know, so it can stop suggesting things into that window and so it can
move a nudge that would otherwise land while the owner is abroad.

## 2. The governing principle

**Nothing unresolved is ever dropped.**

One principle sits behind three cases, an unanswered nudge, a conflicting date, and
an interview the owner walked away from, so there is one mechanism for all three, the open item
(`occasions/cadence.ts`, `OccasionStateStore.openItems`). Silence never ends
anything. It only moves a date.

## 3. Where each piece lives, and why

| Thing | Lives in | Why |
|---|---|---|
| Occasion declarations (what, whose, date, kind, lead override) | The owner's profile file | A durable fact about the owner's life that they own and can hand-edit. |
| Plans | The owner's profile file | Same. |
| Acknowledgement state (asked when, answered what, expires when) | A separate machine-owned store | Machine-written state has no business in a file the owner owns. |
| Gift history (what the owner landed on) | Machine-owned store | Same reason. |
| Calendar mirror records | Machine-owned store | Bookkeeping about a copy, not a fact about the owner. |

The owner-profile design is explicit that **a validator never rewrites a line the
owner wrote**. Writing "asked on the 3rd, answered no" into that file would break
that guarantee, so the two are kept apart:
`~/.goodvibes/daemon/owner-profile.md` and the control-plane state directory's
`occasions-state.json`.

### 3.1 Why an occasion is prose, not a mechanical field

The profile's field registry maps one section-plus-label to one value. It can
hold `commerce.shippingAddress` and it cannot hold twenty birthdays. So
`## Important dates` and `## Plans` are prose-only canonical sections, and the
profile parser preserves each line verbatim exactly as it does any other bullet,
while `occasions/grammar.ts` types them on the way past. A line the grammar cannot
make sense of is reported with a reason and never rewritten.

```
- Sarah's birthday · 03-14 · annual · gift-giving · for Sarah · lead 21
- Dad · 11-02 · annual · remember-only
- Our anniversary · 2015-09-12 · annual · gift-giving · for Jane
- Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon
```

Segments after the title are classified by SHAPE, not position, so the owner can
write them in any order and add one later. Anything unrecognised is kept verbatim.
`·` is canonical and `|` is accepted, because a middot is awkward to type.

### 3.2 The persisted-state treatment

`OccasionStateStore` is bounded (caps per collection, oldest first), validated
record by record (a malformed record is dropped and counted, never the file),
reaped on schedule (an answer expires with its occurrence), swept (orphans and
aged gift history), and it discloses what it holds through `occasions.state`.
A profile that declares no occasions at all (unreadable, not loaded yet, or emptied) cannot
tell "every line was removed" from "nothing could be read", so the orphan rules wait
until at least one occasion is declared; expiry by date still runs, and removing an
occasion through its verb still drops its own records.
A line that is still under the heading but does not parse (a mistyped date, a
misspelt kind) counts as declared by its title, so a typo costs none of its
answers. Gift history is never dropped as an orphan at all: a retitled line keeps
the old history readable through `occasions.gifts` under the old name until it
ages out (`occasions.giftHistoryYears`) or the occasion is removed through its verb.
Every write is ordered through `StoreWriteQueue`, because the sweep runs on a timer while
an answer arrives over a channel, and an unordered write would put the file back
without the answer, so the owner would be asked again about something they had
already answered.

## 4. Owner rulings

These behaviors are contractual. Do not revise them silently.

### 4.1 Lead time: 10 days, with a per-occasion override
Enough runway to order something and have it arrive. `occasions.leadDays`, and a
line carrying `lead 21` overrides it for that occasion alone.

### 4.2 Channel: Telegram **and** the agent. Never the TUI
The TUI is a get-work-done interface; an occasion nudge belongs on the channels
that reach the owner away from work.

**And** rather than **or**: `occasions.nudgeChannel` is a comma-separated list,
so `telegram,agent` names both. Telegram is pushed to; a failure there is
recorded rather than thrown, so an expired Telegram token cannot stop the agent
hearing about an approaching occasion.

The agent is not pushed to: it is another process. It reads what is outstanding
through `occasions.pending`, at the end of each turn and once per sweep interval
while idle. When a sweep raises something and the list names `agent`, the daemon
publishes `DELIVERY_WAITING` (job `occasions`, surface `agent`) on the
`deliveries` event domain, and a connected Agent with no turn running reads at
once. The event carries no text.

**This generalises beyond this feature.** The TUI is a work interface;
life-admin and proactive personal nudges belong on Telegram and the agent.
`resolveNudgeDestinations` refuses a TUI target structurally rather than merely
not choosing one, and a list that names the TUI alongside real destinations
loses the TUI entry and keeps the rest.

#### One thing said once
Every way the agent hears a reminder is the same read of the **same open item**,
which stays open until the owner answers it, from either side. There is no
second record of "already told" to disagree with it, and an Agent that was not
running when the sweep raised the item reads it when it next starts.

### 4.3 A nudge names the occasion but **never the date**
The ruling is that a nudge may name the occasion, but the date itself is disclosed
only when the owner explicitly asks for it.

Stronger than "do not print the date": "in 10 days" is the date with arithmetic
applied. So proximity is a WORD, approaching, soon, or imminent, chosen from a
day count that never leaves `occasions/nudge.ts`. Side effect worth preserving:
a reminder delivered to Telegram never puts family birth dates into a message
channel. `occasions.list` does return the dates, because that is the owner asking their
own system over an authenticated verb, the explicit ask that unlocks a
closed-tier read.

### 4.3a Who a date is about
A line written with `for me` is the owner's own; nothing else is needed. The one
case where who a date is about changes anything is a `remember-only` line
without `for me`: if it is the owner's own (their birthday), it is listed and
never pushed at them. Only that case is read by the decision model, once per
line, and the answer is kept until the line's title, its person or the owner's
declared names change, so sweeps, lists and the Agent's per-turn pull ask
nothing when nothing changed. With no decision model, or when the reading
cannot be taken, the line is treated as about someone else and is pushed as
normal. Everything else about a reminder (the window, the boundaries, the
wording) is worked out in code, so reminders are raised, pushed and listed the
same with or without a decision model; the results then say
`provenance: "classic"`. Saying "it's mine" at capture (`self: true` on
`occasions.confirm`) writes `for me` and settles it for good.

### 4.4 Occasion **kind** is chosen by the owner at capture time, never inferred
Kinds: **gift-giving**, **remember-only**, and **neither**. `occasions.confirm`
refuses without one. A parent's death anniversary might well be worth
remembering, and a cheerful "you'll probably want to sort something" against it
would be genuinely bad. Never guess.

### 4.5 A date captured from conversation is confirmed **once**, at the time
*"Noted your anniversary as 12 September, right?"* One line, at the moment the
owner can still catch a mishearing. Silent afterwards; no re-confirmation at
nudge time. For an annual date a silent write means the error surfaces up to
eleven months later.

### 4.6 Silence does not end anything, but the push does not repeat
There is no give-up-after-one-retry behavior. The open ITEM persists and stays enumerable until it
is resolved or its date passes, so asking "anything coming up?" always finds it.
That is what "nothing unresolved drops" means, and it is not a licence to say the
same thing again.

**Two touches is the ceiling** (contractual, 2026-08-05, after a single occasion
was raised five times in one day). An occasion is raised ONCE when it enters its
lead window, and at most once more on the day itself. Between those it stays open
and quiet. The ceiling is structural. Each raise records which of the two
boundaries it served, and a served boundary is never served again, so no sweep
interval, restart or clock change can produce a third push. A boundary counts as served
only once a destination accepted the push: if every destination refuses, the boundary stays
available and the next sweep tries again.
A push a destination accepted is recorded as served even if a setting or the
profile changed while it was being sent, so it is never pushed a second time.
A date conflict and an unfinished gift conversation are pushed the same way, as a line that
names the occasion and never a date, and are recorded as raised under the same rule: only
once a destination accepted them, or at once when nothing is set up to push to.

The earlier rhythm here was every `occasions.cadenceDays` days, then daily for
the last `occasions.finalStretchDays`. That was an implementation choice rather
than a ruling, flagged as such and not objected to at the time, and it is what
turned an hourly sweep into an hourly reminder.

Two keys change as a result:

- `occasions.cadenceDays` now governs only conflict re-raise (§4.12).
- `occasions.finalStretchDays` is REMOVED. A count of two has nothing to tune,
  and a setting that changes nothing is worse than no setting.

### 4.7 Quiet hours: 8am to 10pm, in the owner's timezone
Hours inside that range are fine to nudge in; anything outside it is not, so the
system stays quiet outside the range. `occasions.activeHours`, reckoned in
`daemon.timezone`. Outside the window nothing is dropped. It waits.

### 4.8 Declining goes silent until the date passes, then asks fresh next year
One "no" ends it for this cycle. The record expires WITH THE OCCURRENCE, so next
year asks again carrying no memory of the refusal. For a one-off, "handled" is
permanent.

### 4.9 "Later" is a distinct answer
"Not yet" three weeks out is not a decline. It returns roughly halfway to the
date.

### 4.10 Yes opens a **short interview**, not a shopping trip
A yes opens a few questions whose job is to guide the owner towards a good gift
idea. The agent does **not** make the recommendation. It opens from what the
profile already knows (People and Notes prose, verbatim), records **what the
owner landed on** rather than merely that they said yes, and keeps it to
`occasions.interviewQuestions` questions. A thread the owner goes quiet on is a
dropped thread, not a completion, and it resumes at the unanswered question.

### 4.11 Removal takes one confirmation
Not unquestioned, and not an argument. People divorce and people die. Orphaned
acknowledgement state is dropped with the occasion.

### 4.12 Conflicting dates: raise immediately, and again later if ignored
Two different dates for one thing are both reported. The newer value is never
taken silently. The owner's answer is applied with `occasions.conflict.resolve`
and `keep` set to the date that is right: the other lines for that title are
removed from the profile (a profile write, with its authority), the answers and
gift history stay, and the conflict is not raised again. Without `keep` nothing
changes and the recorded dates come back to put to the owner.

### 4.13 Travel and away state feeds nudge timing
A known future location for the owner is licence to modify timing such as when a
nudge lands. A nudge due inside an away window moves EARLIER, to the day before
departure, because nothing can be delivered to a house the owner is not in. Once
they have already left there is nothing earlier to move to and the nudge stands.
The lead window moves with it: it is measured back from the day before
departure, so a birthday late in a long trip is still raised before the owner
leaves.

### 4.14 Bulk entry is not needed in v1
Skipped.

## 5. Calendar: the profile is the record, the calendar is a mirror

The design rule is that profile dates are permanent records; calendar entries are
ephemeral, normally not persisting across occurrences. The calendar may carry a
mirror of the profile, never the other way around.

- **Profile → calendar: allowed**, behind `occasions.calendarMirror` (off by
  default).
- **Calendar → profile: NEVER.** There is no calendar-shaped input to
  `occasions/reader.ts` at all, so this is structural rather than a rule someone
  has to remember. Calendar feed content from outside the owner is also
  untrusted content, so ingesting occasions from one would be wrong twice over.
- **Deleting the calendar entry never deletes the occasion.** Nothing reads a
  calendar, so there is no path by which it could.
- **Mirrored occasions suppress our nudge** (`occasions.suppressMirroredNudges`),
  so the calendar's own reminder is the only ping.
- **The mirror is idempotent.** It is keyed by occasion AND occurrence, so re-writing
  the same occasion each year adds one record and never accumulates duplicates.

## 6. Implementation decisions, stated so they can be overridden

- Several occasions inside one window **batch into a single message**.
- A **29 February** occasion fires on the 28th in non-leap years. Skipping it is
  what a naive implementation does, and it means the feature silently does
  nothing three years in four.
- The occasion carries the person as a **plain label**, rather than restructuring
  the People section, which is prose-only by design.
- Nudge cadence as in §4.6.
- Nudges push to Telegram by default (`occasions.nudgeChannel = telegram`), the
  owner's ruling. The key takes a **list**, so `telegram,agent` reaches both,
  the ruling in §4.2 (Telegram by a push, the agent by its read), and each
  entry may carry an address (`telegram:12345,agent`). Setting the key to empty
  makes the feature **pull-only** instead: nothing is pushed or announced, and
  `occasions.pending` is how a surface sees what is outstanding.
- The list is not restricted to those two. Any channel surface the delivery
  router can reach is a valid entry, because where the owner wants to hear about
  this is the owner's call and not a shortlist. What is fixed is the exclusion:
  the TUI is refused whatever is set.
- A dropped interview resumes the **next day**.

## 7. The control-plane surface

Everything a surface needs is a verb. A consumer that computed anything beyond
calling these and rendering the answers would be a second implementation of a
rule that lives in the daemon, most dangerously the rule that a nudge never
carries the date.

| Verb | Scope | What it is for |
|---|---|---|
| `occasions.list` | `read:occasions` | Every occasion, its next occurrence, days away, window, recorded answer; unparsed lines with reasons; conflicts. |
| `occasions.propose` | `write:occasions` | What would be written, plus the one-line confirmation. Writes nothing. |
| `occasions.confirm` | `write:occasions` | Write the confirmed occasion. Refuses without a kind. `self: true` marks the owner's own date (`for me`). |
| `occasions.update` | `write:occasions` | Change an occasion's date, kind, person, recurrence, lead or `self` in place. The id stays, so answers and gift history stay with it; a different name is refused. Without `confirmed` it returns the line and the sentence to put to the owner and writes nothing. |
| `occasions.remove` | `write:occasions` | One confirmation; removes the line and every record against it. |
| `occasions.answer` | `write:occasions` | yes / no / later / acknowledged. A yes opens the interview; acknowledged is the same as `occasions.acknowledge`. |
| `occasions.acknowledge` | `write:occasions` | Record that the owner has one occurrence in hand, without ending the question: the open item stays open and stops being pushed. Distinct from `answer`, which resolves and removes the item. An occurrence already answered yes or no is left as it is and the reply says so (`changed: false`). |
| `occasions.interview.get` | `read:occasions` | Resume at the unanswered question. |
| `occasions.interview.answer` | `write:occasions` | Record one answer, return the next question. |
| `occasions.interview.record` | `write:occasions` | Close with what the owner landed on; writes gift history. |
| `occasions.gifts` | `read:occasions` | What the owner landed on in previous years. |
| `occasions.pending` | `read:occasions` | Everything outstanding, delivered to nobody. Lists a date inside its window even before any sweep has run. Lists every open item until it is answered; this is how the agent hears a reminder (§4.2). |
| `occasions.sweep` | `write:occasions` | Run one pass now. |
| `occasions.conflict.resolve` | `write:occasions` | Apply the owner's answer: `keep` names the right date and the other lines are removed (§4.12). Without `keep`, returns the recorded dates and changes nothing. |
| `occasions.plans.list` | `read:occasions` | Plans, and whether one has the owner away today. |
| `occasions.plans.propose` | `write:occasions` | Same two-step capture, for a plan. |
| `occasions.plans.confirm` | `write:occasions` | Write the confirmed plan, with every entry of `details` (a confirmation number, flights and times), which `occasions.plans.list` returns. |
| `occasions.plans.update` | `write:occasions` | Change a plan in place, by its id (and `planFrom` when two plans share a name). Same two steps as `occasions.update`. |
| `occasions.plans.remove` | `write:occasions` | One confirmation; removes the plan's line. |
| `occasions.state` | `read:occasions` | What the machine-owned store holds; counts and reasons only. |

`occasions.confirm`, `occasions.plans.confirm`, `occasions.update`,
`occasions.plans.update`, `occasions.remove` and `occasions.plans.remove` write to
the owner's profile and therefore take `authority` as a required parameter, go
through the profile's own write gate, and refuse a caller that declares the call
was not a user request.

## 8. Settings

All daemon-owned (`config-ownership.ts`), because the sweep runs in the daemon
with every surface closed. All eleven defaults were confirmed by the owner key by
key on 2026-07-28; ten stood as proposed and `occasions.nudgeChannel` changed
from empty to `telegram`. The "source" column below records where each default
came from originally.

| Key | Default | Source of the default |
|---|---|---|
| `occasions.enabled` | `true` | Not pinned by the plan; a feature that ships off ships dark. |
| `occasions.leadDays` | `10` | Owner ruling §4.1. |
| `occasions.activeHours` | `08:00-22:00` | Owner ruling §4.7. |
| `occasions.nudgeChannel` | `telegram` | Owner ruling, 2026-07-28: nudges push to Telegram out of the box. A comma-separated list, so `telegram,agent` is the §4.2 ruling in full; empty makes it pull-only. |
| `occasions.cadenceDays` | `3` | Implementation choice, flagged (§4.6). Conflict re-raise only since the two-touch ruling. |
| `occasions.awayAdjust` | `true` | Owner ruling §4.13. |
| `occasions.calendarMirror` | `false` | Not pinned; §5 permits mirroring, it does not require it. |
| `occasions.suppressMirroredNudges` | `true` | Owner ruling §5. |
| `occasions.interviewQuestions` | `3` | Not pinned; §4.10 says "genuinely short". |
| `occasions.giftHistoryYears` | `10` | Not pinned; §4.10 says year three should not be steered by year one. |
| `occasions.sweepIntervalMinutes` | `60` | Not pinned; the plan does not say how often the sweep runs, only that it runs. |

## 8.1 What runs the sweep

A loop that only runs when a verb asks it to is not proactive, and proactive is
the whole feature, so the composition arms a repeating timer
(`occasions/ticker.ts`), re-read from config every tick so
`occasions.sweepIntervalMinutes` is live rather than restart-only. The first
pass is timed from the last stored sweep rather than from start: when the last
one is older than the interval (or there is none) a pass runs shortly after the
daemon starts, so a machine that is restarted or only on for a while still gets
its reminders.

The ticker is deliberately dumb, because the sweep is where the judgement is. A
tick inside quiet hours raises nothing and reaps anyway, and a tick on a day an
occasion has already been raised finds its open item not yet due. The interval
therefore decides how soon the FIRST nudge lands after a window opens and
nothing else. Shortening it cannot make the system nag.

Passes are strictly serial. The next tick is armed only when the current pass
finishes, so a slow sweep delays the next one rather than having one start on
top of it and deliver the same batch twice. The re-arm sits in a `finally`, so
one transient failure cannot end the loop for the life of the process, and the
timer is `unref`'d so it never holds the daemon open.

## 9. What this feature deliberately does not do

Several adjacent things were discussed with the owner and marked "on the list",
"not now" or "think about it later". None of them is built here, and none of them
is scaffolded here either, no stub, no extension seam, no flag. The open-item
loop is a general mechanism and would serve some of them one day, but nothing in
this code refers to any of them.
