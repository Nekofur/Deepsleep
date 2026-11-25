"""公用脚本的薄封装。

真正的实现在 D:\\opencodexiangmu\\Tool\\android-icon\\gen.py，
已登记在 knowledge\\memory\\脚本程序.xlsx。要改生成逻辑请改公用那份。

用法：python scripts/gen-android-icon.py [--res <res 目录>]
不传 --res 时，公用脚本默认使用当前目录下的 android/app/src/main/res。
"""

import pathlib
import runpy
import sys

# .../app/scripts/gen-android-icon.py -> parents[5] 即 D:\opencodexiangmu
WORKSPACE = pathlib.Path(__file__).resolve().parents[5]
SHARED = WORKSPACE / "Tool" / "android-icon" / "gen.py"

sys.argv = [str(SHARED), *sys.argv[1:]]
runpy.run_path(str(SHARED), run_name="__main__")
