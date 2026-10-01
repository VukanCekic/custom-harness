---
name: wordle-solver
description: Strategy, workflow, and browser automation instructions for solving Wordle puzzles autonomously using browserclaw refs.
---

# Wordle Solver Workflow

Follow this systematic strategy when tasked with playing or solving Wordle:

## 1. Launch & Navigate
- Open the Wordle game:
  `browser({ command: "open https://www.nytimes.com/games/wordle/index.html" })`
- Take an interactive snapshot:
  `browser({ command: "snapshot -i" })`
- Review the snapshot. Every interactive button has a ref, e.g. `[ref=e5]`.
- Always interact using refs:
  - If a "Play" button appears (e.g. `button "Play" [ref=e5]`), click it: `browser({ command: "click @e5" })`.
  - If a "Continue to Wordle" button appears (e.g. `button "Continue to Wordle" [ref=e11]`), click it: `browser({ command: "click @e11" })`.
  - If a "How to Play" or "Statistics" modal dialog appears, click its Close button ref (e.g. `button "Close" [ref=e1]`).

## 2. Typing Guesses
- Wordle does not have an `<input>` tag—it listens to keyboard events directly!
- Use `keyboard type` to enter letters:
  `browser({ command: "keyboard type CRANE" })`
- Then press Enter to submit:
  `browser({ command: "press Enter" })`
- Wait 2 seconds for tile animations to settle:
  `browser({ command: "wait 2000" })`

## 3. Analyze Feedback
To inspect the board state, evaluate the tile statuses:
`browser({ command: "eval \"Array.from(document.querySelectorAll('[data-testid=tile]')).slice(0,30).map((t,i)=>(i%5===0?'\\nRow '+(i/5+1)+': ':'')+('['+(t.textContent||'_')+': '+(t.getAttribute('data-state')||'empty')+']')).join(' ')\"" })`

Interpret the letters:
- **`correct` (Green)**: The letter is in the correct position. (Lock it in: `_ R _ _ _`).
- **`present` (Yellow)**: The letter exists in the solution, but NOT in this position.
- **`absent` (Gray)**: The letter is not in the solution. Do not reuse eliminated letters.

## 4. Next Guesses
- Deduce 5-letter candidate words strictly matching all known Green letters, containing all Yellow letters (in different positions), and avoiding all Gray letters.
- Type candidate with `keyboard type <WORD>`, submit with `press Enter`, wait 2 seconds, and inspect tiles.
- Repeat until all 5 tiles in a row show `correct`.

## 5. Report Results
When solved:
- Announce the solution word and number of attempts (e.g. 3/6).
- Format and present the classic Wordle emoji grid (🟩, 🟨, ⬜) in your response.
- Close the browser: `browser({ command: "close" })`.
