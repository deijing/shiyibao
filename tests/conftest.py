import os
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# 将导入时的应用数据写入与开发者真实配置隔离，
# 并使测试套件在受限 CI 沙箱中保持确定性。
os.environ.setdefault(
    "SHIYIBAO_DATA_DIR",
    str(Path(tempfile.gettempdir()) / "shiyibao-tests"),
)
