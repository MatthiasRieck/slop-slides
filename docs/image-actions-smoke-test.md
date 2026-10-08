# Desktop image-action smoke test

Run this against the desktop app after changes to image menus, Tauri IPC, dialogs, or the opener. The unit tests mock the native boundary, so passing them does not establish that a desktop menu selection opens a dialog or viewer.

1. Build and launch the current desktop app. Open a deck containing a local image.
2. Right-click the image and choose **Download image…**. Confirm that the native save dialog opens with the image's filename. Cancel once and check that no file was created and no error appears.
3. Repeat Download and save into a temporary folder. Compare the saved file with the original deck asset; the bytes must match. On macOS/Linux, `cmp /path/to/original.png /path/to/download.png` should exit successfully.
4. Reopen the menu and choose **Open image in another window**. Confirm that the system image viewer opens the original asset. Check its filename/path so an unrelated existing viewer window cannot count as success.
5. Repeat both actions after reopening the menu, changing slides, and zooming or panning the canvas. Confirm that the currently clicked image is used and both menu items stay clickable.
6. Repeat the actions in full-screen presentation mode. Escape should dismiss an open image menu before it exits the presentation.

For an embedded data-URI image, Download should preserve its decoded bytes and Open should display the same image from the app's cache. For a remote image, test both an accessible URL and a failed download; a failed action must show an error.
