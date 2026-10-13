# Canvases

A canvas is an Excalidraw drawing that you and the agent share. Open one from the right panel's add menu with "Canvas"; the panel lists the project's canvases and starts a new one. You draw in the panel, and the agent can read the same drawing, add to it, and look at a screenshot of it while it works.

Canvases are plain `.excalidraw` files in a `.canvases` folder of the project's main checkout, so they open in excalidraw.com or the Excalidraw VS Code extension too, and can be committed with the project. To keep them somewhere else, set **Canvas folder** in Settings for all projects or pick one project with the [scope selector](project-settings.md). The agent can also open any other `.excalidraw` file on the machine by path.

Ask the agent to sketch something ("draw the auth flow on a canvas") or to work from a drawing you made. Its canvas tool calls name the canvas and have an "Open canvas" button. Edits from both sides merge, so you can keep drawing while the agent updates the canvas. Drawings saved as `.excalidraw.png` or `.excalidraw.svg` open read-only.

Screenshots for the agent come from the same small headless browser used for [visual replies](html-renders.md), which downloads once on first use.
