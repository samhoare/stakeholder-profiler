/**
 * Example plugin: logs each pipeline stage without modifying any data.
 *
 * Plugin lifecycle hooks (all optional):
 *
 *   beforeResearch({ name, role, company })
 *     Called before the research phase begins. Return an object to override
 *     name/role/company passed to the research queries.
 *
 *   afterResearch({ name, role, company, research, sources })
 *     Called after all research is gathered. Return { research, sources }
 *     to replace or augment the research text and source list.
 *
 *   afterProfile({ name, role, company, research, sources, profile })
 *     Called after the final profile JSON is built. Return { profile }
 *     to modify or extend the profile before it is sent to the client.
 *
 * To create your own plugin, copy this file, change the name, implement
 * whichever hooks you need, and drop it in the plugins/ directory.
 */
module.exports = {
  name: "example-logger",

  beforeResearch({ name, role, company }) {
    const subject = [name, role, company].filter(Boolean).join(", ");
    console.log(`[example-logger] Research starting for: ${subject}`);
  },

  afterResearch({ name, sources }) {
    console.log(`[example-logger] Research finished for: ${name} — ${sources.length} source(s) collected`);
  },

  afterProfile({ name, profile }) {
    console.log(`[example-logger] Profile complete for: ${name} (confidence: ${profile.confidence})`);
  },
};
