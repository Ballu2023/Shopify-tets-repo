---
description: Fill inputs/style-guide.json from the style guide files / Figma screenshots and regenerate the theme tokens.
---
Run the **design-reader** subagent with "Mode: style". When it returns, show the user a compact table of the final colours,
fonts, H1–H6/p/span sizes (desktop/mobile) and button styles from `inputs/style-guide.json`, and ask them to confirm or correct.
If they correct anything, edit the JSON and rerun `node pipeline/tokens.js`.
