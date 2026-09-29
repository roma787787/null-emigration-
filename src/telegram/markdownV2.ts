// What Telegram's MarkdownV2 parser would reject — used by the unit tests and the e2e
// harnesses, so every card is checked the way the real Bot API would check it.
export /** Returns why Telegram would reject this MarkdownV2 text, or null. */
function markdownV2Problem(text: string): string | null {
  const reserved = "_*[]()~`>#+-=|{}.!";
  const open: string[] = [];
  const toggle = (token: string) => {
    if (open.at(-1) === token) open.pop();
    else if (open.includes(token)) throw new Error(`badly nested ${token}`);
    else open.push(token);
  };
  try {
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      const context = () => JSON.stringify(text.slice(Math.max(0, i - 15), i + 15));
      if (c === "\\") {
        if (i + 1 >= text.length) return "trailing backslash";
        i++;
      } else if (c === "_" && text[i + 1] === "_") {
        toggle("__");
        i++;
      } else if (c === "|" && text[i + 1] === "|") {
        toggle("||");
        i++;
      } else if (c === "*" || c === "_" || c === "~") {
        toggle(c);
      } else if (c === "`") {
        const end = text.indexOf("`", i + 1);
        if (end < 0) return "unclosed code";
        i = end;
      } else if (c === "[") {
        open.push("[");
      } else if (c === "]") {
        if (open.at(-1) !== "[") return `']' without '[' at ${context()}`;
        open.pop();
        if (text[i + 1] === "(") {
          let j = i + 2;
          while (j < text.length && text[j] !== ")") j += text[j] === "\\" ? 2 : 1;
          if (j >= text.length) return "unclosed link url";
          i = j;
        }
      } else if (c === ">" && (i === 0 || text[i - 1] === "\n")) {
        // block quote
      } else if (reserved.includes(c)) {
        return `unescaped '${c}' at ${context()}`;
      }
    }
  } catch (err) {
    return (err as Error).message;
  }
  return open.length ? `unclosed ${open.join(" ")}` : null;
}
