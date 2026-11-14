export const PRELUDE = `def scale(root, mode):
    if mode == "major":
        return root + "/8 " + transpose(root, "M2") + "/8 " + transpose(root, "M3") + "/8 " + transpose(root, "P4") + "/8 " + transpose(root, "P5") + "/8 " + transpose(root, "M6") + "/8 " + transpose(root, "M7") + "/8 " + transpose(root, "P8") + "/8"
    if mode == "minor":
        return root + "/8 " + transpose(root, "M2") + "/8 " + transpose(root, "m3") + "/8 " + transpose(root, "P4") + "/8 " + transpose(root, "P5") + "/8 " + transpose(root, "m6") + "/8 " + transpose(root, "m7") + "/8 " + transpose(root, "P8") + "/8"
    return root

def chord(root, quality):
    if quality == "minor":
        return "<" + root + " " + transpose(root, "m3") + " " + transpose(root, "P5") + ">"
    if quality == "dim":
        return "<" + root + " " + transpose(root, "m3") + " " + transpose(root, "d5") + ">"
    return "<" + root + " " + transpose(root, "M3") + " " + transpose(root, "P5") + ">"
`;

export function builtinHelp(markdown: string): Record<string, string> {
  const help: Record<string, string> = {};
  const pattern = /^## Builtin `([A-Za-z_]+)`\r?\n\r?\n([\s\S]*?)(?=\r?\n## |\r?\n# |$)/gm;
  for (const match of markdown.matchAll(pattern)) {
    help[match[1]!] = match[2]!.trim();
  }
  return help;
}
