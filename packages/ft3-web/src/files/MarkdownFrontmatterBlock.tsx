export function MarkdownFrontmatterBlock(props: { readonly frontmatter: string }) {
  return (
    <div className="mx-auto max-w-4xl px-6 pt-5">
      <pre
        data-ft3-markdown-frontmatter=""
        className="overflow-x-auto rounded-lg bg-(--code-background) px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre text-(--code-foreground)"
      >
        {props.frontmatter}
      </pre>
    </div>
  );
}