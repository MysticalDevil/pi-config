export default {
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  rules: {
    "no-underscore-dangle": "off",
    "unicorn/no-array-reverse": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/consistent-function-scoping": "off",
  },
  ignorePatterns: [
    "agent/npm",
    "agent/sessions",
    "agent/themes",
    "agent/skills",
    "node_modules",
  ],
};
