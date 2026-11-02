// The GitHub Release for this version, made once before electron-builder uploads its files.
// Left to electron-builder, two uploads starting together each made a release of their own
// (two "v0.5.2" releases, the files split between them). Needs GH_TOKEN.
import fs from "node:fs";

const { version, build } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const { owner, repo } = build.publish[0];
const tag = `v${version}`;
const api = `https://api.github.com/repos/${owner}/${repo}`;
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" };

const all = await fetch(`${api}/releases?per_page=100`, { headers }).then((r) => r.json());
if (Array.isArray(all) && all.some((r) => r.tag_name === tag)) {
  console.log(`release ${tag} is there`);
} else {
  const r = await fetch(`${api}/releases`, { method: "POST", headers, body: JSON.stringify({ tag_name: tag, name: version, draft: false }) });
  if (!r.ok) throw new Error(`creating release ${tag}: ${r.status} ${await r.text()}`);
  console.log(`made release ${tag}`);
}
