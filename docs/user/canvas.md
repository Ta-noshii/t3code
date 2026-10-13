# Canvases

A canvas is an Excalidraw drawing that you and the agent share. Open one from the right panel's add menu with "Canvas"; the panel lists the project's canvases and starts a new one. You draw in the panel, and the agent can read the same drawing, add to it, and look at a screenshot of it while it works.

Canvases are plain `.excalidraw` files in a `.canvases` folder of the project's main checkout, so they open in excalidraw.com or the Excalidraw VS Code extension too, and can be committed with the project. To keep them somewhere else, set **Canvas folder** in Settings for all projects or pick one project with the [scope selector](project-settings.md). The agent can also open any other `.excalidraw` file on the machine by path.

Group related canvases in folders inside the canvas folder. Start one with the new-folder button, add canvases with the plus button next to a folder's name, and move a canvas with **Move to** in its menu. A folder exists while it holds a canvas, so moving or deleting the last one removes it. Folders you make by hand show up too; hidden ones (starting with a dot) are skipped. The agent puts canvases in folders when asked, and refers to them as `folder/name`.

Ask the agent to sketch something ("draw the auth flow on a canvas") or to work from a drawing you made. Its canvas tool calls name the canvas and have an "Open canvas" button. Edits from both sides merge, so you can keep drawing while the agent updates the canvas. Drawings saved as `.excalidraw.png` or `.excalidraw.svg` open read-only.

In the mobile app, open a thread's project canvases with **Canvases** in the thread's Git menu on iPhone, or the canvas button in the thread header on Android. Touch and hold a canvas to rename, move, or delete it, and use the photo button in a canvas to add a picture from the library, the camera, or the clipboard. When the agent opens a canvas in the thread you are reading, a notice above the composer offers to open it. The app loads the editor from the computer running T3 Code, so that computer needs a version with canvases.

Screenshots for the agent come from the same small headless browser used for [visual replies](html-renders.md), which downloads once on first use.
