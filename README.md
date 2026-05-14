# winsiner.github.io

winsiner의 게임 랜딩 페이지 모음. `https://winsiner.github.io/` 에 호스팅됩니다.

## 구조

```
/                                   → 회사 메인 (게임 목록)
/quantum-match/                     → Quantum Match 랜딩
/quantum-match/s/?score=12345       → 점수 공유 페이지 (Universal Link target)
/quantum-match/privacy.html         → 개인정보처리방침
/.well-known/apple-app-site-association  → iOS Universal Link 검증
/.well-known/assetlinks.json        → Android App Link 검증
```

## 추가/수정 시 주의

### Apple AASA 파일
- 파일명은 정확히 `apple-app-site-association` (확장자 없음)
- `details[]`에 새 앱 추가 시 `appID`는 `<TeamID>.<bundleId>` 형식
- iOS는 캐시가 길어서 (~24h) 변경 후 검증은 `https://app-site-association.cdn-apple.com/a/v1/winsiner.github.io` 로 확인

### Android assetlinks.json
- `sha256_cert_fingerprints` 는 **Play App Signing의 키** SHA-256 (본인 업로드 키가 아님)
- Play Console → Setup → App integrity → App signing key certificate → SHA-256 복사
- 변경 후 검증: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://winsiner.github.io&relation=delegate_permission/common.handle_all_urls`

## GitHub Pages 활성화

1. Repo Settings → Pages
2. Source: Deploy from a branch
3. Branch: `main` / `/ (root)`
4. Save → 몇 분 후 `https://winsiner.github.io/` 가 활성화됨

## 새 게임 추가

```
/<game-name>/index.html
/<game-name>/s/index.html  (공유 페이지)
/<game-name>/privacy.html
```

그리고 `/.well-known/apple-app-site-association` 의 `details[]` 배열에 해당 게임 appID + paths 추가.
