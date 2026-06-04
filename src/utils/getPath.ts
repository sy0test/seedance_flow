import path from "path";
import isPathInside from "is-path-inside";

export default (fileName?: string[] | string) => {
  let basePath: string;
  if (typeof process.versions?.electron !== "undefined") {
    const { app } = require("electron");
    // 开发模式（dev:gui）下数据文件在 cwd/data/，未打包时不执行 initializeData()
    if (app.isPackaged) {
      const userDataDir: string = app.getPath("userData");
      basePath = path.join(userDataDir, "data");
    } else {
      basePath = path.join(process.cwd(), "data");
    }
  } else {
    basePath = path.join(process.cwd(), "data");
  }
  if (fileName) {
    let dbPath: string;
    if (Array.isArray(fileName)) {
      dbPath = path.resolve(basePath, ...fileName);
    } else {
      dbPath = path.resolve(basePath, fileName);
    }
    if (!isPathInside(dbPath, basePath) && dbPath !== basePath) {
      throw new Error("路径逃逸错误，路径必须在数据目录内");
    }
    return dbPath;
  }
  return basePath;
};

export function isElectron() {
  if (typeof process.versions?.electron !== "undefined") {
    const { app: _app } = require("electron");
    return true;
  } else {
    return false;
  }
}
