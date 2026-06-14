// Fixture: a CommonJS tailwind.config.cjs for the JS-eval adapter test (theme + extend merge path).
module.exports = {
  content: [],
  theme: {
    extend: {
      colors: { primary: "#3b82f6", gray: { 100: "#f3f4f6" } },
      spacing: { sm: "8px", md: "16px" },
      borderRadius: { card: "12px" },
      fontSize: { body: ["16px", { lineHeight: "24px" }] },
      fontFamily: { sans: ["Inter", "sans-serif"] },
    },
  },
};
