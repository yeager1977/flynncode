import { plugin } from "bun"
import { createRequire } from "node:module"

// Bun compiles JSX for React, so browser tests that render Solid components need Solid's compiler. Its Babel
// preset ships with vite-plugin-solid; Babel only swaps JSX for DOM templates and Bun then strips the types.
const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const babel = require("@babel/core") as typeof import("@babel/core")
const solid = require.resolve("babel-preset-solid")
const strip = new Bun.Transpiler({ loader: "ts", trimUnusedImports: true })

plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\/packages\/[^/]+\/src\/.*\.tsx$/ }, async (args) => {
      const result = await babel.transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        sourceMaps: "inline",
        parserOpts: { plugins: ["jsx", "typescript"] },
        presets: [[solid, { generate: "dom", hydratable: false }]],
      })
      return { contents: strip.transformSync(result?.code ?? ""), loader: "js" }
    })
  },
})
