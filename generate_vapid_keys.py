"""
Web Push 표준 VAPID 키 생성기 (generate_vapid_keys.py)
- 실행 시 Web Push 푸시 알림에 필요한 VAPID 공개키와 개인키를 생성합니다.
- 생성된 키는 .env 및 Vercel/GitHub Secrets에 등록하여 사용합니다.
"""

import sys
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

def generate_keys():
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()
    
    pub_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint
    )
    b64_pub = base64.urlsafe_b64encode(pub_bytes).decode('utf-8').rstrip('=')
    
    priv_num = private_key.private_numbers().private_value
    priv_bytes = priv_num.to_bytes(32, byteorder='big')
    b64_priv = base64.urlsafe_b64encode(priv_bytes).decode('utf-8').rstrip('=')
    
    print("=" * 60)
    print("🔑 [Web Push VAPID 키 생성 완료]")
    print("=" * 60)
    print(f"VAPID_PUBLIC_KEY={b64_pub}")
    print(f"VAPID_PRIVATE_KEY={b64_priv}")
    print(f"VAPID_CLAIMS_SUB=mailto:admin@example.com")
    print("=" * 60)
    print("👉 VAPID_PUBLIC_KEY는 프론트엔드와 백엔드 모두에서 사용됩니다.")
    print("👉 VAPID_PRIVATE_KEY는 백엔드(GitHub Actions/서버)에만 비밀로 보관합니다.")
    print("=" * 60)
    
    return b64_pub, b64_priv

if __name__ == "__main__":
    generate_keys()
