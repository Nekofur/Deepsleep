/**
 * 公用脚本的薄封装。
 *
 * 真正的实现在 D:\opencodexiangmu\Tool\android-build\build.mjs，
 * 已登记在 knowledge\memory\脚本程序.xlsx。要改构建逻辑请改公用那份，
 * 这里只负责在本项目里保持 `pnpm android:build` 这条命令可用。
 *
 * 注意：工作区的相对层级是 app/scripts -> app -> 项目 -> projects -> DSH -> opencodexiangmu。
 */
import '../../../../../Tool/android-build/build.mjs'
