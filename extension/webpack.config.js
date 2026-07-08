const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: {
    background: "./src/background.ts",
    offscreen: "./src/offscreen.ts",
    "content-script": "./src/content-script.ts",
    popup: "./src/popup/popup.ts",
    options: "./src/options/options.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "manifest.json", to: "manifest.json" },
        { from: "src/popup/popup.html", to: "popup.html" },
        { from: "src/options/options.html", to: "options.html" },
        // offscreen.html goes to dist root (same level as offscreen.js)
        { from: "src/offscreen/offscreen.html", to: "offscreen.html" },
        { from: "icons", to: "icons" },
      ],
    }),
  ],
};
