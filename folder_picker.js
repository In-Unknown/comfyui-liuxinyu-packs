import { app } from "../../scripts/app.js";

const NODE_NAME = "SaveImageToAbsolutePath";

app.registerExtension({
  name: "SaveImageToPath.FolderPicker",

  async nodeCreated(node) {
    if (node.comfyClass !== NODE_NAME) return;

    const folder = node.widgets?.find((w) => w.name === "folder");
    if (!folder || folder.__saveImageToPathFolderPicker) return;
    folder.__saveImageToPathFolderPicker = true;

    const button = node.addWidget(
      "button",
      "选择文件夹",
      "save_image_to_path_select_folder",
      async () => {
        await openFolderPicker(folder);
      },
      {
        serialize: false,
        canvasOnly: true,
      },
    );

    // addWidget() appends the button; move it immediately below the folder STRING widget.
    const widgets = node.widgets;
    const folderIndex = widgets.indexOf(folder);
    const buttonIndex = widgets.indexOf(button);
    if (folderIndex >= 0 && buttonIndex >= 0 && buttonIndex !== folderIndex + 1) {
      widgets.splice(buttonIndex, 1);
      widgets.splice(folderIndex + 1, 0, button);
    }

    button.label = "选择文件夹";
    node.setDirtyCanvas(true, true);
  },
});

async function openFolderPicker(folderWidget) {
  try {
    const currentFolder = typeof folderWidget.value === "string" ? folderWidget.value.trim() : "";
    const query = currentFolder ? `?folder=${encodeURIComponent(currentFolder)}` : "";
    const response = await fetch(`/save_image_to_path/select_folder${query}`, {
      method: "GET",
        headers: { "Accept": "application/json" },
    });
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    if (!data.folder) return;

    folderWidget.value = data.folder;
    folderWidget.callback?.(data.folder);
    app.graph?.setDirtyCanvas(true, true);
  } catch (error) {
    console.error("[SaveImageToPath] Folder picker failed:", error);
  }
}
