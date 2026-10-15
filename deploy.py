#!/usr/bin/env python3
"""
=========================================================================
배포 자동화 & 리그레션 테스트 파이프라인 (deploy.py)
규칙: node test_regression.js 전수 검사를 통과하지 못하면 배포를 절대 진행하지 않습니다.
=========================================================================
"""

import subprocess
import sys
import os

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

def run():
    print("=" * 60)
    print("🚀 [배포 파이프라인 가동] 배포 전 자동 리그레션 테스트 실행")
    print("=" * 60)

    # 1. 리그레션 테스트 실행
    test_result = subprocess.run(["node", "test_regression.js"], cwd=os.path.dirname(os.path.abspath(__file__)))
    if test_result.returncode != 0:
        print("\n" + "!" * 60)
        print("🚨 [배포 즉시 중단] 리그레션 테스트에서 결함이 감지되었습니다.")
        print("    오류가 완벽히 수정될 때까지 Vercel 배포를 실행하지 않습니다.")
        print("!" * 60)
        sys.exit(test_result.returncode)

    print("\n" + "=" * 60)
    print("✅ [검증 완료] 모든 테스트(문법, DOM, API) 통과! Vercel 배포를 시작합니다.")
    print("=" * 60)

    public_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
    import vault
    token = vault.get_secret("VERCEL_TOKEN", "")
    if not token:
        token = os.environ.get("VERCEL_TOKEN", "")
    cmd = ["cmd.exe", "/c", f"npx vercel --prod --token {token} --yes"]
    
    deploy_result = subprocess.run(cmd, cwd=public_dir)
    if deploy_result.returncode != 0:
        print("❌ Vercel 배포 도중 네트워크 또는 빌드 오류가 발생했습니다.")
        sys.exit(deploy_result.returncode)

    print("\n" + "=" * 60)
    print("🎉 [최종 성공] 검증된 최신 버전이 Vercel Production에 배포되었습니다!")
    print("=" * 60)

if __name__ == "__main__":
    run()
