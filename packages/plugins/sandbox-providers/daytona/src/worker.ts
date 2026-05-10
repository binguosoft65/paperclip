// Worker 入口：使用 Plugin SDK 的 runWorker 将插件注册到 Paperclip 控制平面
// runWorker 会建立与 Paperclip 后台的消息通道，处理传入的插件事件
import { runWorker } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

export default plugin;
runWorker(plugin, import.meta.url);
