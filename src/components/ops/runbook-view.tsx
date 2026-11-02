import { useState } from "react";

export function RunbookView({ source }: { source: string }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const blocks = parseBlocks(source);
  const checks = blocks.filter((block) => block.kind === "check");
  const done = checks.filter((block) => checked[block.id]).length;

  return (
    <article className="max-w-3xl">
      <p className="mb-4 text-sm text-muted">
        上线检查 {done}/{checks.length}。勾选只留在这次演练里，刷新即清空。
      </p>
      <div className="flex flex-col gap-3">
        {blocks.map((block) => {
          if (block.kind === "h1") {
            return (
              <h2 key={block.id} className="mt-2 text-xl font-semibold tracking-tight">
                {block.text}
              </h2>
            );
          }
          if (block.kind === "h2") {
            return (
              <h3 key={block.id} className="mt-4 text-lg font-semibold">
                {block.text}
              </h3>
            );
          }
          if (block.kind === "check") {
            const on = checked[block.id] ?? false;
            return (
              <label key={block.id} className="flex min-h-11 items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-accent"
                  checked={on}
                  onChange={() => setChecked((prev) => ({ ...prev, [block.id]: !on }))}
                />
                <span className={on ? "text-muted line-through" : ""}>{block.text}</span>
              </label>
            );
          }
          if (block.kind === "li") {
            return (
              <p key={block.id} className="pl-4 text-sm">
                <span className="mr-2 text-accent">·</span>
                {block.text}
              </p>
            );
          }
          if (block.kind === "table") {
            return (
              <div key={block.id} className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-0 border-collapse text-left text-sm">
                  <tbody>
                    {block.rows.map((row) => (
                      <tr key={row.join("|")} className="border-t border-line first:border-t-0">
                        {row.map((cell) => (
                          <td key={cell} className="px-3 py-2 align-top">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          return (
            <p key={block.id} className="text-sm text-fg">
              {block.text}
            </p>
          );
        })}
      </div>
    </article>
  );
}

type Block =
  | { kind: "h1" | "h2" | "p" | "li" | "check"; id: string; text: string }
  | { kind: "table"; id: string; rows: string[][] };

function parseBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("|")) {
        const cells = (lines[index] ?? "")
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
        if (!cells.every((cell) => /^[-:\s]+$/.test(cell))) rows.push(cells);
        index += 1;
      }
      blocks.push({ kind: "table", id: `b${blocks.length}`, rows });
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ kind: "h2", id: `b${blocks.length}`, text: line.slice(3) });
    } else if (line.startsWith("# ")) {
      blocks.push({ kind: "h1", id: `b${blocks.length}`, text: line.slice(2) });
    } else if (line.startsWith("- [ ] ")) {
      blocks.push({ kind: "check", id: `b${blocks.length}`, text: line.slice(6) });
    } else if (line.startsWith("- ")) {
      blocks.push({ kind: "li", id: `b${blocks.length}`, text: line.slice(2) });
    } else if (/^\d+\.\s/.test(line)) {
      blocks.push({ kind: "li", id: `b${blocks.length}`, text: line.replace(/^\d+\.\s/, "") });
    } else {
      blocks.push({ kind: "p", id: `b${blocks.length}`, text: line });
    }
    index += 1;
  }
  return blocks;
}
