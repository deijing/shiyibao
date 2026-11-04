import json
import uuid
from pathlib import Path

import pytest

from server.routers import task
from server.services.translate import clean_video_title


@pytest.mark.parametrize(("raw", "expected"), [
    # 模型不按要求、返回 JSON 或类 JSON 的各种形态
    ('{"title": "AI帮我一周发博八十三条重回金V"}', "AI帮我一周发博八十三条重回金V"),
    ("{ title AI帮我一周发博八十三条重回金V }", "AI帮我一周发博八十三条重回金V"),
    ("{title: 非遗汝瓷为何如此昂贵}", "非遗汝瓷为何如此昂贵"),
    ("{\n  title AI帮我一周发博八十三条重回金V\n}", "AI帮我一周发博八十三条重回金V"),  # 历史数据的真实形态
    ('{\n  "title": "AI帮我一周发博八十三条重回金V"\n}', "AI帮我一周发博八十三条重回金V"),
    ('```json\n{"标题": "千亿身价的汝瓷"}\n```', "千亿身价的汝瓷"),
    ('["汝瓷的秘密"]', "汝瓷的秘密"),
    ("标题：汝瓷的秘密", "汝瓷的秘密"),
    ("《汝瓷的秘密》", "汝瓷的秘密"),
    ("“汝瓷的秘密”。\n这个标题突出了……", "汝瓷的秘密"),
    # 正常标题不能被误伤
    ("【干货】Python 入门", "【干货】Python 入门"),
    ("Python 入门 (上)", "Python 入门 (上)"),
    ("解读《红楼梦》里的瓷器", "解读《红楼梦》里的瓷器"),
    ("Title IX Explained", "Title IX Explained"),
    ("", ""),
])
def test_clean_video_title(raw: str, expected: str) -> None:
    assert clean_video_title(raw) == expected


def test_task_list_repairs_stored_braced_title(monkeypatch, tmp_path: Path) -> None:
    """作品档案页走的是 /api/tasks 列表接口，同样要返回并落盘干净标题。"""
    import asyncio

    tasks_dir, projects_dir = tmp_path / "tasks", tmp_path / "projects"
    projects_dir.mkdir()
    task_id = str(uuid.uuid4())
    (tasks_dir / task_id).mkdir(parents=True)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)
    monkeypatch.setattr(task, "PROJECTS_DIR", projects_dir)
    bad = "{ title AI帮我一周发博八十三条重回金V }"
    (tasks_dir / task_id / "task.json").write_text(json.dumps(
        {"task_id": task_id, "filename": "a.mp4", "stage": "complete", "video_title": bad,
         "project_folder_name": f"【{task._sanitize_folder_name(bad)}】_{task_id[:8]}"},
        ensure_ascii=False), encoding="utf-8")

    listed = asyncio.run(task.list_tasks())
    assert listed[0]["video_title"] == "AI帮我一周发博八十三条重回金V"
    assert listed[0]["project_folder_name"] == f"【AI帮我一周发博八十三条重回金V】_{task_id[:8]}"
    assert task._read_meta(task_id)["video_title"] == "AI帮我一周发博八十三条重回金V"


def test_delete_task_removes_project_alias(monkeypatch, tmp_path: Path) -> None:
    import asyncio

    tasks_dir, projects_dir, uploads_dir = tmp_path / "tasks", tmp_path / "projects", tmp_path / "uploads"
    projects_dir.mkdir()
    task_id = str(uuid.uuid4())
    (tasks_dir / task_id).mkdir(parents=True)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)
    monkeypatch.setattr(task, "PROJECTS_DIR", projects_dir)
    monkeypatch.setattr(task, "UPLOADS_DIR", uploads_dir)
    alias = projects_dir / f"【汝瓷】_{task_id[:8]}"
    alias.symlink_to((tasks_dir / task_id).resolve(), target_is_directory=True)
    other = projects_dir / "别的工程"
    other.symlink_to(tmp_path, target_is_directory=True)

    asyncio.run(task.delete_task(task_id))
    assert not alias.is_symlink()
    assert other.is_symlink()  # 其他任务的快捷目录不受影响


def test_status_repairs_stored_braced_title(monkeypatch, tmp_path: Path) -> None:
    tasks_dir, projects_dir = tmp_path / "tasks", tmp_path / "projects"
    projects_dir.mkdir()
    task_id = str(uuid.uuid4())
    (tasks_dir / task_id).mkdir(parents=True)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)
    monkeypatch.setattr(task, "PROJECTS_DIR", projects_dir)
    bad = "{\n  title AI帮我一周发博八十三条重回金V\n}"
    old_alias = f"【{task._sanitize_folder_name(bad)}】_{task_id[:8]}"
    (projects_dir / old_alias).symlink_to(tasks_dir / task_id, target_is_directory=True)
    (tasks_dir / task_id / "task.json").write_text(json.dumps(
        {"task_id": task_id, "filename": "a.mp4", "stage": "complete", "video_title": bad,
         "project_folder_name": old_alias}, ensure_ascii=False), encoding="utf-8")

    status = task._status(task._read_meta(task_id))
    assert status.video_title == "AI帮我一周发博八十三条重回金V"
    assert task._read_meta(task_id)["video_title"] == "AI帮我一周发博八十三条重回金V"  # 已落盘
    # 工程快捷目录也换成干净的名字，旧的带花括号的链接被移除
    assert not (projects_dir / old_alias).is_symlink()
    assert (projects_dir / f"【AI帮我一周发博八十三条重回金V】_{task_id[:8]}").is_symlink()
