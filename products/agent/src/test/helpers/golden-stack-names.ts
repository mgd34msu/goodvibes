/** The bottom-of-screen stack goldens: one per (mode, width), named the way golden-frames-stack.test.ts writes them. */
export const STACK_WIDTHS = [80, 120, 160] as const;
export const STACK_MODES = ['rest', 'thinking', 'tool', 'tree', 'scrolled', 'scrolled-tool'] as const;
export type StackMode = (typeof STACK_MODES)[number];

export const stackGoldenName = (mode: StackMode, width: number): string => `stack-${mode}-${width}`;
export const STACK_GOLDEN_NAMES: readonly string[] = STACK_WIDTHS.flatMap((width) => STACK_MODES.map((mode) => stackGoldenName(mode, width)));
