/** What an agent or process view changes under the transcript. */
export interface ShellFooterView {
    /** The composer bar: the agent's lane color, or the process color. */
    readonly barColor: string;
    readonly placeholder?: string | undefined;
    /** The composer takes no input; this says why. */
    readonly disabledReason?: string | undefined;
    /** The view's keys on the status line (esc back to main, ctrl+x stop, …). */
    readonly keys: ReadonlyArray<readonly [
        string,
        string
    ]>;
    /** After the keys: main kept in sight (◐ main · working). */
    readonly trail?: ({
        readonly text: string;
        readonly fg: string;
    } | null) | undefined;
    /** A notice in place of the keys (press ctrl+x again to stop). */
    readonly notice?: ({
        readonly text: string;
        readonly tone: 'error' | 'info';
    } | null) | undefined;
    /** The process view shows no context bar or cost. */
    readonly noContext?: boolean | undefined;
    /** The cost this view states instead of the session's (an agent's own, when priced). */
    readonly cost?: (string | null) | undefined;
}
