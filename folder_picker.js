import { app } from "../../scripts/app.js";

const SAVE_IMAGE_NODE = "SaveImageToAbsolutePath";
const LOAD_PATH_NODE = "LoadPath";

app.registerExtension({
  name: "SaveImageToPath.FolderPicker",

  async nodeCreated(node) {
    if (node.comfyClass === SAVE_IMAGE_NODE) {
      setupFolderPicker(node);
    } else if (node.comfyClass === LOAD_PATH_NODE) {
      setupFilePicker(node);
    }
  },
});

function setupFolderPicker(node) {
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

  const widgets = node.widgets;
  const folderIndex = widgets.indexOf(folder);
  const buttonIndex = widgets.indexOf(button);
  if (folderIndex >= 0 && buttonIndex >= 0 && buttonIndex !== folderIndex + 1) {
    widgets.splice(buttonIndex, 1);
    widgets.splice(folderIndex + 1, 0, button);
  }

  button.label = "选择文件夹";
  node.setDirtyCanvas(true, true);
}

function setupFilePicker(node) {
  const path = node.widgets?.find((w) => w.name === "path");
  if (!path || path.__saveImageToPathFilePicker) return;
  path.__saveImageToPathFilePicker = true;

  const button = node.addWidget(
    "button",
    "选择文件",
    "save_image_to_path_select_file",
    async () => {
      await openFilePicker(path);
    },
    {
      serialize: false,
      canvasOnly: true,
    },
  );

  const widgets = node.widgets;
  const pathIndex = widgets.indexOf(path);
  const buttonIndex = widgets.indexOf(button);
  if (pathIndex >= 0 && buttonIndex >= 0 && buttonIndex !== pathIndex + 1) {
    widgets.splice(buttonIndex, 1);
    widgets.splice(pathIndex + 1, 0, button);
  }

  button.label = "选择文件";
  node.setDirtyCanvas(true, true);
}

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

async function openFilePicker(pathWidget) {
  try {
    const currentPath = typeof pathWidget.value === "string" ? pathWidget.value.trim() : "";
    const query = currentPath ? `?path=${encodeURIComponent(currentPath)}` : "";
    const response = await fetch(`/save_image_to_path/select_file${query}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    if (!data.path) return;

    pathWidget.value = data.path;
    pathWidget.callback?.(data.path);
    app.graph?.setDirtyCanvas(true, true);
  } catch (error) {
    console.error("[SaveImageToPath] File picker failed:", error);
  }
}
