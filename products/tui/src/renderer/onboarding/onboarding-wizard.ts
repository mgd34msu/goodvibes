/**
 * renderOnboardingWizard, one `/setup` topic's form on the modal surface kit.
 *
 * The form owns the screen (the shell hides its header and footer): the ✦
 * title row with `/setup` and the topic, the topic's sentence, its rows (a
 * value right-aligned on each, ◇ on a changed one), Save as the last row, and a
 * focus box that says in full what the selected row does. There is no list of
 * other screens and no count: another topic is another `/setup` choice.
 */

import { activeTokens, activeUiTones } from '../theme.ts';
import {
  beginModal,
  finishModal,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from '../surface-kit.ts';
import { drawList, type KitRow } from '../surface-kit-list.ts';
import { inset } from '../surface-kit-parts.ts';
import { drawTextBlock, textBlockHeight, type TextLine } from '../surface-kit-extra.ts';
import type {
  OnboardingWizardController,
  OnboardingWizardFieldDefinition,
} from '../../input/onboarding/onboarding-wizard.ts';

function fieldBadgeTone(wizard: OnboardingWizardController, field: OnboardingWizardFieldDefinition): string {
  const tones = activeUiTones();
  if (field.kind === 'status' || field.kind === 'modelPicker') return tones.state.info;
  if (field.kind === 'acknowledgement') {
    const label = wizard.getFieldValueLabel(field);
    return label === 'Accepted' ? tones.state.good : label === 'Pending' ? tones.state.warn : tones.fg.muted;
  }
  if (field.kind === 'checklist') return wizard.getFieldValue(field) ? tones.state.good : tones.fg.muted;
  if (field.kind === 'radio') return tones.state.active;
  if (field.kind === 'text' || field.kind === 'masked') {
    if (wizard.getFieldValueLabel(field) === 'Missing') return tones.state.warn;
    if (field.kind === 'masked') return tones.state.warn;
  }
  return tones.fg.secondary;
}

function fieldMark(wizard: OnboardingWizardController, field: OnboardingWizardFieldDefinition): string | undefined {
  if (wizard.isFieldDirty(field.id)) return '◇';
  if (field.kind === 'checklist' || field.kind === 'acknowledgement') return wizard.getFieldValue(field) ? '✓' : '□';
  if (field.kind === 'action') return '▶';
  if (field.kind === 'radio') return '◉';
  return undefined;
}

/** Field rows; spacer rows before a field are kept as blank rows. */
function fieldRows(wizard: OnboardingWizardController): { rows: KitRow[]; scrollStart: number } {
  const t = activeTokens();
  const rows: KitRow[] = [];
  const selectedIndex = wizard.getSelectedFieldIndex();
  const scrollField = wizard.scrollOffsets[wizard.stepIndex] ?? 0;
  let scrollStart = 0;
  wizard.currentStep.fields.forEach((field, index) => {
    for (let k = 0; k < Math.max(0, field.spacerBeforeRows ?? 0); k++) rows.push({ label: '' });
    if (index === scrollField) scrollStart = rows.length;
    rows.push({
      label: field.label,
      mark: fieldMark(wizard, field),
      markFg: wizard.isFieldDirty(field.id) ? t.warning : t.brand,
      right: wizard.getFieldValueLabel(field),
      rightFg: fieldBadgeTone(wizard, field),
      selected: index === selectedIndex,
    });
  });
  return { rows, scrollStart };
}

/** The focus box's lines: what the selected field is and what it does, in full. */
function focusLines(wizard: OnboardingWizardController): TextLine[] {
  const t = activeTokens();
  if (wizard.isEditingTextField() && wizard.editingFieldId !== null) {
    const field = wizard.getFieldById(wizard.editingFieldId);
    if (field && (field.kind === 'text' || field.kind === 'masked')) {
      const raw = wizard.editBuffer.length > 0 ? wizard.editBuffer : field.placeholder;
      const shown = field.kind === 'masked' && wizard.editBuffer.length > 0
        ? '•'.repeat(Math.min(12, Math.max(4, wizard.editBuffer.length)))
        : raw;
      return [
        { text: `Editing: ${field.label}`, style: { fg: t.text, bold: true } },
        { text: `${shown}▏`, style: { fg: t.text } },
        { text: field.hint, style: { fg: t.textMuted } },
      ];
    }
  }
  const field = wizard.getSelectedField();
  if (!field) return [{ text: 'No selectable row is active on this screen.', style: { fg: t.textMuted } }];
  let hint = field.hint;
  if (field.kind === 'modelPicker') hint = `${hint} Press Enter to open the picker.`;
  if (field.kind === 'text' || field.kind === 'masked') hint = `${hint} Press Enter to edit inline.`;
  // A value the wizard will refuse (a confirmation that does not match, a bad
  // port) is said at the field, not only at apply.
  const problem = wizard.getFieldValidationError(wizard.currentStep, field);
  return [
    { text: `${field.label} · ${wizard.getFieldValueLabel(field)}`, style: { fg: t.text, bold: true } },
    ...(problem !== null ? [{ text: problem, style: { fg: t.error, bold: true } }] : []),
    { text: hint, style: { fg: t.textMuted } },
  ];
}

function hintsFor(wizard: OnboardingWizardController): KitHint[] {
  if (wizard.isEditingTextField()) {
    return [['⏎', 'save'], ['esc', 'cancel edit'], ['bksp', 'delete char'], ['del', 'clear']];
  }
  return [['↑↓', 'move'], ['⏎', 'change'], ['del', 'clear'], ['esc', 'close']];
}

/**
 * Render the form as a SurfaceLayer covering the screen (x 1, y 0).
 * `width` and `viewportHeight` are the screen size the form owns.
 */
export function renderOnboardingWizard(
  wizard: OnboardingWizardController,
  width: number,
  viewportHeight: number,
): SurfaceLayer {
  const t = activeTokens();
  const step = wizard.currentStep;
  const hints = hintsFor(wizard);
  // The form owns the screen: full width minus 1 per side, full height.
  // beginModal sizes against a screen tall enough that the requested height
  // is never clamped; the layer is then placed at the top row.
  const height = Math.max(5, viewportHeight - 2);
  const f = beginModal(width, Math.max(viewportHeight * 2, 12), {
    // Named as the place it opens from (System, Setup), never a command to type.
    title: 'Setup',
    sub: step.title,
    hints,
    width: width - 2,
    height,
    dim: false,
  });
  const x0 = f.l;
  const x1 = f.r;
  const textW = x1 - x0 + 1;

  // The topic's sentence, in full.
  let y = drawTextBlock(f.canvas, x0, f.top, textW, [
    { text: step.description, style: { fg: t.textMuted } },
  ], f.bottom) + 1;

  // The focus box at the bottom sizes to its text (never clipped); the
  // field rows get the rows between.
  const focus = focusLines(wizard);
  const insetTextW = textW;
  const focusRows = textBlockHeight(focus, insetTextW);
  const detailH = Math.min(focusRows + 2, Math.max(3, f.bottom - y - 1));
  const detailY = f.bottom - detailH + 1;
  const p = inset(f.canvas, x0 - 2, detailY, textW + 4, detailH);
  drawTextBlock(f.canvas, p.l, p.top, p.r - p.l + 1, focus, p.bottom);

  const listBottom = detailY - 2;
  if (y > listBottom) y = listBottom;
  const fields = fieldRows(wizard);
  if (fields.rows.length === 0) {
    drawTextBlock(f.canvas, x0, y, textW, [{ text: 'Nothing to set here.', style: { fg: t.textMuted } }], listBottom);
  } else {
    const res = drawList(f.canvas, { rows: fields.rows, top: y, bottom: listBottom, x0, x1, scrollStart: fields.scrollStart });
    f.hintRight = scrollCountText(res.above, res.below);
  }
  return { ...finishModal(f), y: 0 };
}
