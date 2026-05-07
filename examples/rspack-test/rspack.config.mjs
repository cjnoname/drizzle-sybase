import { defineConfig } from "@rspack/cli";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.TARGET_PLATFORM ?? `${process.platform}-${process.arch}`;

export default defineConfig({
  mode: "production",
  entry: "./src/main.ts",
  target: "node",
  output: {
    filename: "main.mjs",
    path: path.resolve(__dirname, "dist"),
    chunkFormat: "module",
    chunkLoading: "import",
    library: { type: "module" },
    clean: true,
    module: true
  },
  resolve: {
    extensions: [".ts", ".js", ".node"],
    symlinks: true
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: { syntax: "typescript" },
            target: "es2022"
          }
        }
      },
      {
        test: /\.node$/,
        oneOf: [
          {
            // Target platform → emit as asset
            test: new RegExp(target.replace("-", "\\-")),
            type: "asset/resource"
          },
          {
            // Other platforms → empty, don't emit
            type: "asset/source",
            generator: { emit: false }
          }
        ]
      }
    ]
  },
  optimization: {
    minimize: false
  },
  experiments: {
    outputModule: true
  }
});
