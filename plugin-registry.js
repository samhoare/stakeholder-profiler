const fs = require("fs");
const path = require("path");

class PluginRegistry {
  constructor() {
    this.plugins = [];
  }

  register(plugin) {
    if (!plugin || !plugin.name) {
      throw new Error("Plugin must export an object with a 'name' property");
    }
    this.plugins.push(plugin);
    console.log(`[plugins] Registered: ${plugin.name}`);
    return this;
  }

  // Load all .js files from a directory as plugins, sorted alphabetically.
  loadFromDirectory(dir) {
    if (!fs.existsSync(dir)) return this;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js")).sort();
    for (const file of files) {
      try {
        const plugin = require(path.join(dir, file));
        this.register(plugin);
      } catch (e) {
        console.error(`[plugins] Failed to load ${file}:`, e.message);
      }
    }
    return this;
  }

  // Run all plugins that implement hookName sequentially, passing context through.
  // Each plugin may return an object whose keys are merged into context for the next plugin.
  async runHook(hookName, context) {
    let result = { ...context };
    for (const plugin of this.plugins) {
      if (typeof plugin[hookName] !== "function") continue;
      try {
        const output = await plugin[hookName](result);
        if (output && typeof output === "object") {
          result = { ...result, ...output };
        }
      } catch (e) {
        console.error(`[plugins] ${plugin.name}.${hookName} threw:`, e.message);
      }
    }
    return result;
  }
}

module.exports = new PluginRegistry();
