import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 安卓构建入口：把本机环境差异集中在这里，避免每次手动拼环境变量。
 *
 * 这台机器踩过的坑（换机器前先看这里）：
 * 1. Capacitor 8 / AGP 8.13 需要 JDK 21，系统默认的 java17 会报「无效的源发行版:21」。
 * 2. 新装的 JDK 21 写不了 C:\Users\<用户>\.gradle、.android 和 Temp（安全软件拦截），
 *    所以 GRADLE_USER_HOME / ANDROID_USER_HOME / TMP 全部改到工作区里。
 * 3. Gradle 官方下载地址会超时，发行包走镜像下载并按官方 SHA-256 校验过。
 *
 * 可用环境变量覆盖：JAVA_HOME_21、ANDROID_HOME、GRADLE_USER_HOME、ANDROID_USER_HOME、GRADLE_BIN。
 */
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// app → 项目目录 → projects → DSH → D:\opencodexiangmu
const workspace = path.resolve(appDir, '..', '..', '..', '..')
const scratch = path.join(workspace, 'DSH')

const firstExisting = (candidates, label) => {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  console.error(`找不到${label}，已尝试：\n${candidates.filter(Boolean).join('\n')}`)
  process.exit(1)
}

const javaHome = firstExisting(
  [
    process.env.JAVA_HOME_21,
    path.join(workspace, 'Tool', 'java21'),
    path.join(workspace, 'Tool', 'java21', 'jdk-21.0.2'),
  ],
  ' JDK 21'
)
const androidHome = firstExisting(
  [process.env.ANDROID_HOME, path.join(workspace, 'Tool', 'android-sdk')],
  ' Android SDK'
)
const gradleBin = firstExisting(
  [
    process.env.GRADLE_BIN,
    // 优先用已解压的发行版：wrapper 走镜像下载时拿到过坏包，直接调 gradle 更稳
    path.join(process.env.USERPROFILE ?? '', '.gradle', 'wrapper', 'dists', 'gradle-8.14.3-bin',
      '40dfek2kz346l18gf9ltjsnyd', 'gradle-8.14.3', 'bin', 'gradle.bat'),
    path.join(appDir, 'android', 'gradlew.bat'),
  ],
  ' Gradle 可执行文件'
)

const tmpDir = path.join(scratch, '.tmp')
const gradleHome = process.env.GRADLE_USER_HOME ?? path.join(scratch, '.gradle')
const androidUserHome = process.env.ANDROID_USER_HOME ?? path.join(scratch, '.android')
for (const dir of [tmpDir, gradleHome, androidUserHome]) {
  mkdirSync(dir, { recursive: true })
}

const task = process.argv[2] ?? 'assembleDebug'
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_USER_HOME: androidUserHome,
  GRADLE_USER_HOME: gradleHome,
  TMP: tmpDir,
  TEMP: tmpDir,
}

console.log(`JAVA_HOME=${javaHome}`)
console.log(`ANDROID_HOME=${androidHome}`)
console.log(`GRADLE_USER_HOME=${gradleHome}`)
console.log(`TMP=${tmpDir}`)

const result = spawnSync(gradleBin, [task, '--console=plain'], {
  cwd: path.join(appDir, 'android'),
  stdio: 'inherit',
  env,
  shell: true,
})
process.exit(result.status ?? 1)
