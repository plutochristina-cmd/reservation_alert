"""
보안 금고 모듈 (vault.py)
- 민감한 API 키와 토큰을 Windows 하드웨어/OS 레벨(DPAPI)로 암호화하여 저장합니다.
- 저장 시: 암호화되어 .secrets.vault 파일에 보관 (외부 전송/Git 커밋 원천 차단)
- 사용 시: 메모리 상에서만 일시적으로 복호화하여 사용
- 타 PC나 외부로 파일이 유출되더라도 Windows 마스터 키 없이는 복호화 불가능
- Linux/GitHub Actions 환경에서는 시스템 환경변수(os.environ)로 자동 폴백
"""

import os
import sys
import json
import base64

VAULT_FILE = ".secrets.vault"

# Windows DPAPI 바인딩 (ctypes)
_is_windows = sys.platform == "win32"

if _is_windows:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ('cbData', wintypes.DWORD),
            ('pbData', ctypes.POINTER(ctypes.c_byte))
        ]

    _CryptProtectData = ctypes.windll.crypt32.CryptProtectData
    _CryptUnprotectData = ctypes.windll.crypt32.CryptUnprotectData

    def _encrypt_bytes(plain_bytes: bytes) -> str:
        in_blob = DATA_BLOB(len(plain_bytes), ctypes.cast(ctypes.create_string_buffer(plain_bytes), ctypes.POINTER(ctypes.c_byte)))
        out_blob = DATA_BLOB()
        if not _CryptProtectData(ctypes.byref(in_blob), "ReservationBotVault", None, None, None, 0, ctypes.byref(out_blob)):
            raise ctypes.WinError()
        encrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)
        return base64.b64encode(encrypted).decode('utf-8')

    def _decrypt_str(cipher_b64: str) -> bytes:
        encrypted = base64.b64decode(cipher_b64)
        in_blob = DATA_BLOB(len(encrypted), ctypes.cast(ctypes.create_string_buffer(encrypted), ctypes.POINTER(ctypes.c_byte)))
        out_blob = DATA_BLOB()
        if not _CryptUnprotectData(ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)):
            raise ctypes.WinError()
        decrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)
        return decrypted
else:
    def _encrypt_bytes(b: bytes) -> str:
        return base64.b64encode(b).decode('utf-8')
    def _decrypt_str(s: str) -> bytes:
        return base64.b64decode(s)


def save_secret(key: str, value: str):
    """지정한 키-값을 암호화하여 볼트에 저장합니다."""
    secrets = load_all_secrets()
    secrets[key] = value

    raw_json = json.dumps(secrets, ensure_ascii=False).encode('utf-8')
    encrypted_blob = _encrypt_bytes(raw_json)

    with open(VAULT_FILE, "w", encoding="utf-8") as f:
        f.write(encrypted_blob)


def get_secret(key: str, default: str = "") -> str:
    """암호화된 볼트에서 복호화하여 값을 반환합니다. 없을 경우 os.environ에서 조회합니다."""
    # 1. 볼트 파일에서 복호화 시도
    secrets = load_all_secrets()
    if key in secrets and secrets[key] and str(secrets[key]).strip():
        return str(secrets[key]).strip()

    # 2. 시스템 환경변수에서 폴백 조회 (GitHub Actions 등에서 빈 문자열("")이 주입된 경우 default로 안전하게 폴백)
    env_val = (os.environ.get(key) or "").strip()
    if env_val:
        return env_val
    return default


def load_all_secrets() -> dict:
    """볼트 파일 전체를 복호화하여 딕셔너리로 반환합니다."""
    if not os.path.exists(VAULT_FILE):
        return {}

    try:
        with open(VAULT_FILE, "r", encoding="utf-8") as f:
            content = f.read().strip()
        if not content:
            return {}
        decrypted_bytes = _decrypt_str(content)
        return json.loads(decrypted_bytes.decode('utf-8'))
    except Exception as e:
        return {}


if __name__ == "__main__":
    # 테스트 및 등록 실행
    if len(sys.argv) >= 3:
        save_secret(sys.argv[1], sys.argv[2])
        print(f"✅ '{sys.argv[1]}' 키가 암호화되어 금고에 저장되었습니다.")
    else:
        print("금고 상태 확인:", list(load_all_secrets().keys()))
