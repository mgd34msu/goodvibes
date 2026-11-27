/**
 * `workspace.automatic-project-name`: the folder name of the project the daemon makes for a chat that has none
 * (workspace/automatic-projects.ts), picked from short lower-case names code made from the owner's message (its words
 * and pairs of them), or none. `context` is `{ message, kind }`: the owner's message that needed somewhere to work, and
 * the kind of chat (a channel's name, or "chat"). Each candidate's content is the name itself.
 *
 * The selector pattern: one choice over the names plus none, one yes/no per name on whether it says what the work is
 * about. Its no-model path (no decision model set, silently; one that failed, said) is the chat's kind and the date.
 *
 * Band: a wrong name changes only a folder's name, never what is done or where it is allowed, so it is read at low
 * stakes.
 */
import { defineSelector, NONE, STAKES_BANDS } from '@goodvibes/judgment';

const names = (...ids: string[]) => ids.map((id) => ({ id, content: id }));

export const automaticProjectName = defineSelector({
  name: 'workspace.automatic-project-name',
  version: 1,
  description: 'The folder name, among names made from the words of the owner\'s message, that best says what the work of a new chat\'s project is about; or none.',
  accuracyFloor: 0.8,
  instructions: 'The owner sent `message` in `context` in a chat that had no project, and a project folder is made for it now. Which of `candidates` is the best folder name for that project: short, and naming what the work is about (a thing being made or worked on), not a greeting, a verb of asking, or a word that says nothing about the work?',
  fitInstructions: 'Is this candidate a name that says what the work asked for in `message` of `context` is about?',
  band: STAKES_BANDS.low.confidence,
  fitBand: STAKES_BANDS.low.yesNo,
  fixtures: [
    { name: 'the thing being made', context: { message: 'please write a watering schedule for the garden beds', kind: 'telegram' },
      candidates: names('please', 'write', 'watering', 'schedule', 'garden', 'beds', 'watering-schedule', 'garden-beds'), expect: 'watering-schedule' },
    { name: 'the project named outright', context: { message: 'start a little website for the bakery', kind: 'chat' },
      candidates: names('start', 'little', 'website', 'bakery', 'bakery-website', 'little-website'), expect: 'bakery-website' },
    { name: 'a fix in a named tool', context: { message: 'can you fix the csv importer so it reads quoted commas', kind: 'chat' },
      candidates: names('fix', 'csv', 'importer', 'reads', 'quoted', 'commas', 'csv-importer'), expect: 'csv-importer' },
    { name: 'a single word subject', context: { message: 'make me notes about sourdough', kind: 'homeassistant' },
      candidates: names('make', 'notes', 'sourdough', 'sourdough-notes'), expect: 'sourdough-notes' },
    { name: 'nothing says what the work is', context: { message: 'hello there, can you help', kind: 'telegram' },
      candidates: names('hello', 'there', 'help'), expect: NONE },
  ],
});
