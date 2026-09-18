import { expect, test } from "bun:test"
import { collectCandidates } from "../../opencode/src/plugin/ollama-model-router/candidates"
import { rankModels } from "../../opencode/src/plugin/ollama-model-router/rank"
import { parseOptions } from "../../opencode/src/plugin/ollama-model-router/scorecard"
import { emptyForm, serializeForm, TASK_NAMES } from "../src/components/settings-v2/model-router-payload"
import { previewTask, routerCatalog } from "../src/components/settings-v2/model-router-preview"

// Cross-package imports stay outside the app's composite build and runtime.
test("draft previews match the real plugin's selection and ranking contract", () => {
  const source = {
    provider: {
      "ollama-local": { models: { smart: {}, fast: {}, unscored: {}, writer: {} } },
      "ollama-offline": { models: { best: {} } },
      cloud: { models: { remote: {} } },
    },
    disabled_providers: ["ollama-offline"],
  }
  for (const providers of [[], ["cloud"], ["ollama-local", "ollama-offline", "cloud"]]) {
    for (const allowUnscored of [false, true]) {
      for (const zero of [false, true]) {
        const draft = { ...emptyForm(), providers, allowUnscored }
        draft.models = [
          { key: "ollama-local/smart", capability: 10, price: 8, speed: 3, tags: [] },
          { key: "ollama-local/fast", capability: 5, price: 1, speed: 10, tags: [] },
          { key: "ollama-local/writer", capability: 10, price: 1, speed: 10, tags: ["writing"] },
          { key: "ollama-offline/best", capability: 10, price: 1, speed: 10, tags: [] },
          { key: "cloud/remote", capability: 10, price: 1, speed: 10, tags: [] },
          { key: "ollama-local/missing", capability: 10, price: 1, speed: 10, tags: [] },
        ]
        if (zero) TASK_NAMES.forEach((task) => (draft.taskWeights[task] = { capability: 0, price: 0, speed: 0 }))
        // Pin a different model per task, including unscored and tagged-away
        // entries, so previews and plugin must agree on pin precedence.
        draft.taskModels = { coding: "ollama-local/unscored", writing: "ollama-local/smart" }
        // Hidden models are snapshot into excludeModels on save; previews read
        // the same keys through the catalog's enabled flag.
        draft.excludeModels = ["ollama-local/writer"]
        const hidden = new Set(draft.excludeModels)
        const parsed = parseOptions(serializeForm(draft))
        if (!parsed.ok) throw new Error(parsed.errors.join(", "))
        for (const task of TASK_NAMES) {
          const actual = previewTask(
            draft,
            routerCatalog(source, (providerID, modelID) => !hidden.has(`${providerID}/${modelID}`)),
            task,
          )
          const plugin = rankModels(collectCandidates(source, parsed.options), task, draft.taskWeights[task], {
            allowUnscored,
            pinned: parsed.options.taskModels[task],
          })
          expect(actual.map((item) => [item.model.key, item.score])).toEqual(
            plugin.ranked.map((item) => [item.key, item.score]),
          )
        }
      }
    }
  }
})
