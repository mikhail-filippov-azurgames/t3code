import { ContextChip, ContextChipLabel } from "~/components/ContextChip";

export const CommitMentionChip = (props: {
  readonly sha: string;
  readonly label: string;
  readonly onOpen: (sha: string) => void;
}) => (
  <ContextChip
    kind="mention"
    dir="ltr"
    render={<button type="button" />}
    aria-label={`Open commit ${props.label}`}
    data-commit-mention={props.sha}
    data-markdown-copy={props.label}
    onClick={() => props.onOpen(props.sha)}
  >
    <ContextChipLabel className="font-mono">{props.label}</ContextChipLabel>
  </ContextChip>
);
