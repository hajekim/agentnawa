# Agent Nawa — VPC Service Controls 온보딩 가이드

**대상 독자:** 고객사의 Google Cloud **조직/보안 관리자** — VPC Service Controls 경계(perimeter)를 편집하고 프로젝트 IAM을 조직 수준에서 부여할 수 있는 담당자.

**왜 이 문서를 읽나요?** Agent Nawa는 고객사 조직 **외부**(다른 GCP 조직)에서 동작하는 읽기 전용 관리 포털입니다. 대상 프로젝트가 VPC-SC 경계 안에 있으면, 포털의 API 호출이 경계 밖에서 들어오므로 경계에서 차단됩니다:

```
403 ... Request is prohibited by organization's policy.
vpcServiceControlsUniqueIdentifier: <uid>
violations[].type = VPC_SERVICE_CONTROLS
```

이것은 **IAM 문제가 아니라 경계 인그레스(ingress) 거부**입니다. 접근이 성공하려면 **두 가지가 모두** 필요합니다.

1. **인그레스 규칙** — 우리 서비스 계정이 VPC-SC 경계를 넘어오도록 허용
2. **IAM** — 경계를 넘어온 뒤 무엇을 읽을 수 있는지 결정

> 포털에서 이 상태의 연결은 빨간 "오류"가 아니라 **amber "VPC-SC 온보딩 대기"** 로 표시됩니다. 아래 단계를 마치면 자동으로 정상으로 바뀝니다.

---

## 0. 준비 — 우리가 제공하는 입력값

| 값 | 설명 |
|---|---|
| `AGENT_NAWA_SA` | 우리 Cloud Run 런타임 서비스 계정 이메일. **인그레스 규칙이 허용할 신원.** 요청은 고객사 콘솔에 **Cross Organization** 으로 표시됩니다. |
| 우리 프로젝트/조직 ID | 감사 로그 상관관계용 |

**대상 서비스(모두 읽기 전용):**

- `discoveryengine.googleapis.com` — Gemini Enterprise 에이전트 + 라이선스 구성 (location=global)
- `aiplatform.googleapis.com` — Vertex AI Agent Engine / reasoningEngines (region-scoped)
- `bigquery.googleapis.com` — **기본 토폴로지에서는 불필요.** Antigravity 텔레메트리는 조직 로그 싱크를 통해 우리 중앙 프로젝트로 흐릅니다. 고객사가 자체 프로젝트에 텔레메트리 싱크를 두는 경우에만 추가하세요.

**고객사에서 수집할 값:** 조직 ID, 액세스 정책 ID(`POLICY`), 경계 이름(`PERIMETER`), 대상 **프로젝트 번호**(`PROJECT_NUMBER`), Vertex 리전.

```bash
gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)'   # PROJECT_NUMBER
```

**필요 역할:** `roles/accesscontextmanager.policyAdmin`, `roles/resourcemanager.projectIamAdmin`, (4단계용) `roles/accesscontextmanager.vpcScTroubleshooterViewer`.

---

## 1. (DRS를 강제하는 경우) 우리 신원 허용

조직이 도메인 제한 공유(`iam.allowedPolicyMemberDomains`, 2024-05-03 이후 생성된 조직은 기본 활성)를 강제하면, **2단계의 IAM 바인딩 자체가 거부**됩니다(경계 평가 이전에). 먼저 우리 Cloud Identity Customer ID를 허용 목록에 추가하세요.

> DRS 강제 여부가 불확실하면 그대로 2단계를 진행하고, IAM 바인딩이 거부되면 이 단계로 돌아오세요.

---

## 2. 최소 권한 IAM 부여 (대상 프로젝트)

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$AGENT_NAWA_SA" --role="roles/discoveryengine.viewer" --condition=None
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$AGENT_NAWA_SA" --role="roles/aiplatform.viewer" --condition=None
gcloud services enable discoveryengine.googleapis.com aiplatform.googleapis.com --project "$PROJECT_ID"
```

> **주의:** v1alpha "list agents" 호출이 `discoveryengine.viewer`로 IAM 사유(VPC-SC 아님) 403을 낼 수 있습니다. 그럴 경우 `discoveryengine.editor` 또는 에이전트 목록 권한을 추가한 커스텀 역할을 사용하세요. 라이선스 구성 조회는 viewer로 동작합니다.

---

## 3. 인그레스 규칙 추가 (핵심)

`agent-nawa-ingress.yaml` 로 저장:

```yaml
- ingressFrom:
    identities:
      - serviceAccount:AGENT_NAWA_SA        # 다른 조직의 SA 지정은 공식 지원됩니다
    sources:
      - accessLevel: "*"                     # 우리 egress IP는 gce-internal-ip로 마스킹되므로
                                             # IP/resource가 아니라 신원이 유일한 통제축입니다
  ingressTo:
    operations:
      - serviceName: discoveryengine.googleapis.com
        methodSelectors:
          - method: "*"                      # dry-run 후 *Get*/*List* 로 좁힐 수 있음
      - serviceName: aiplatform.googleapis.com
        methodSelectors:
          - method: "*"
    resources:
      - projects/YOUR_PROJECT_NUMBER
```

> **`sources`에는 `accessLevel: "*"` 를 쓰고 `resource:` 는 쓰지 마세요.** 우리 호출자는 경계 외부이고 egress IP가 동적/마스킹되므로 `resource: projects/...` 는 매칭되지 않습니다. 신원(`identities`)이 통제축입니다. 규칙에는 **IAM 역할이 아니라 메서드**를 사용하세요(역할은 다중 리소스 요청에서 오작동).

> ⚠️ **`--set-ingress-policies` 는 기존 인그레스 규칙 전체를 교체합니다.** 반드시 먼저 내보내 병합하세요:
> ```bash
> gcloud access-context-manager perimeters describe "$PERIMETER" \
>   --policy="$POLICY" --format="yaml(status.ingressPolicies)"
> ```

---

## 4. Dry-run → 검증 → enforce

```bash
# 1) dry-run 으로 규칙을 먼저 반영
gcloud access-context-manager perimeters dry-run update "$PERIMETER" \
  --policy="$POLICY" --set-ingress-policies=agent-nawa-ingress.yaml

# 2) 우리에게 포털 연결 테스트를 요청하고, 우리 SA가 ALLOWED(신규 dry-run 위반 없음)인지 확인

# 3) 확인되면 enforce 로 승격
gcloud access-context-manager perimeters dry-run enforce "$PERIMETER" --policy="$POLICY"
```

**트러블슈팅:** 콘솔의 **위반 분석기**(Security → VPC Service Controls → Violation analyzer)에서 API 오류의 `uid` 또는 감사 로그의 `vpcServiceControlsTroubleshootToken`(`protoPayload.metadata.vpcServiceControlsTroubleshootToken`)으로 조회하세요. 포털의 amber 칩에 이 `uid`가 표시됩니다.

흔한 원인: 잘못된 SA 이메일 · `sources`가 `accessLevel:"*"` 가 아님 · `resources`에 이 프로젝트 번호 누락 · VPC-SC가 아닌 **IAM** 사유(→ 경계는 이미 열림, 2단계 IAM을 수정).

---

## 5. 외부 SA를 허용할 수 없는 경우 (Fallback)

보안 정책상 외부/크로스-org 서비스 계정을 인그레스 규칙에 넣을 수 없다면, 우리가 **읽기 전용 수집기를 고객사 경계 내부**(고객사 자체 SA로 실행)에 배포하고 요약 결과만 반출하는 방식(Model B)으로 전환합니다. 외부 신원이 경계에 들어오지 않습니다. (퍼리미터 브리지는 동일 조직 전용이라 크로스-org에는 적용 불가합니다.)

배포 모델 선택 근거는 [vpc-sc-connectivity.md](vpc-sc-connectivity.md)를 참고하세요.

---

## 되돌리기

인그레스 규칙을 제거하고 IAM 바인딩을 회수하면 접근이 완전히 차단됩니다.

```bash
gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$AGENT_NAWA_SA" --role="roles/discoveryengine.viewer"
gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$AGENT_NAWA_SA" --role="roles/aiplatform.viewer"
# 인그레스 규칙: describe 로 현재 목록을 받아 위 규칙만 제거 후 --set-ingress-policies 로 재적용
```
