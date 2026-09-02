# VPC-SC 환경 연결 방안 (내부 의사결정 문서)

**목적:** 엔터프라이즈 고객의 프로젝트가 VPC Service Controls 경계 안에 있을 때 Agent Nawa가 이를 읽는 방법을 정리한다. 고객 관리자용 실행 절차는 [vpc-sc-onboarding.md](vpc-sc-onboarding.md)에 있으며, 이 문서는 옵션/모델/트레이드오프를 다룬다.

## 핵심 결론

경계 안 고객사 연결의 403은 **IAM이 아니라 크로스-org 경계 인그레스 거부**다. 우리 Cloud Run 호출자는 고객 경계 밖(다른 조직)에 있어 L7 경계에서 `VPC_SERVICE_CONTROLS` / `SECURITY_POLICY_VIOLATED`로 차단된다. IAM 역할은 필요조건이지만 충분조건이 아니다 — 고객 경계에 **우리 서비스 계정을 지정한 인그레스 규칙**이 추가로 있어야 통과한다.

유일하게 깔끔한 해법: 고객사 조직 Access Context Manager 관리자가 `ingressFrom.identities`에 우리 SA(`serviceAccount:...@our-project`)를 넣는 인그레스 규칙을 추가한다. 크로스-org SA 지정은 공식 지원되는 데이터 교환 경로다. 우리는 이 변경을 대신 할 수 없고, 정확한 입력값(SA 이메일·서비스·메서드·프로젝트 번호)만 제공한다.

**두 개의 게이트(순서대로):**
1. **IAM / 도메인 제한 공유(DRS).** `iam.allowedPolicyMemberDomains`가 강제되면(2024-05-03 이후 조직 기본 활성) 우리 외부 SA로의 IAM 바인딩 자체가 경계 평가 이전에 차단된다.
2. **VPC-SC 인그레스 규칙.** 우리가 실제로 관측한 403.

## 연결 옵션 매트릭스

| 옵션 | 설정 주체 | 크로스-org | 우리 케이스 해결 | 비고 |
|---|---|---|---|---|
| (a) 인그레스 규칙에 우리 SA를 `identities`로 지정 | 고객 ACM 관리자 | **예** | **✅ 주 해법** | `serviceAccount:...@our-project`, `sources: accessLevel "*"`, 역할 아닌 메서드, 고객 프로젝트 번호로 스코프 |
| DRS 허용 목록에 우리 Customer ID(`is:Cxxxx`) | 고객 정책 관리자 | 예 | 전제조건(IAM 게이트) | 403 수정 이전에 IAM 바인딩을 막음 |
| (b) 액세스 레벨(IP) | 고객 ACM 관리자 | 예 | 선택적 하드닝 | IP 고정은 우리측 Direct VPC egress + Cloud NAT 정적 IP 필요(현재 미배포) |
| (c) 퍼리미터 브리지 | — | **불가(동일 org 전용)** | ❌ | 크로스-org 불가 |
| (d) 고객 경계 내부 실행 (Model B) | 고객 | 불필요(in-org SA) | ✅(배포 모델 변경) | 외부 SA 금지/DRS 차단/상주 요건 시 |
| (e) 우리측 egress + restricted VIP | 우리 | N/A | ❌(레이어 다름) | 우리 네트워크 egress 통제일 뿐, 고객 경계에 무영향 |
| PSC로 중앙 서비스가 고객 API 읽기 | — | 아니오 | ❌(오해) | PSC는 커넥터 전송을 사설화할 뿐, 관리형 Google API를 크로스-org로 노출하지 못함 |

**시간 낭비하지 말 것(크로스-org를 못 푸는 함정):** 퍼리미터 브리지(동일 org 전용) · 우리측 VPC 커넥터/restricted VIP(잘못된 레이어) · PSC · 우리 프로젝트를 고객 경계에 추가(경계는 자기 조직 프로젝트만 포함).

## 배포 모델

- **기본 = Model A.** 중앙 멀티테넌트 Cloud Run 유지 + 고객이 **연결별 전용 SA**(`nawa-conn-<name>@our-project`)에 대한 신원-스코프 인그레스 규칙 추가. 읽기 전용·메타데이터 워크로드에 양측 복잡도 최소(서비스 1개, 코드베이스 1개, 고객측 1회 경계+IAM 편집).
- **Fallback = Model B.** 고객이 외부 SA를 거부 / DRS가 우리 신원을 허용 안 함 / 데이터 상주 요건 시 → 우리 컨테이너를 고객 경계 **내부**에서 고객사 자체 in-org SA로 실행하고, restricted VIP로 API에 접근하며 요약만 반출. 가장 강한 보안 자세, 가장 높은 온보딩 마찰.
- **Model C.** Model B + 리포트 채널을 PSC로 사설화. Model B 고객이 공개 인터넷 egress도 금지할 때만.

**규칙 형태(검증됨):** `identities`에 SA, `sources: [{accessLevel:"*"}]`(우리 egress IP가 `gce-internal-ip`로 마스킹돼 IP 액세스 레벨 매칭 불가 → 신원이 유일 통제축), `ingressTo`를 서비스+읽기 전용 메서드와 `resources:[projects/PROJECT_NUMBER]`로 스코프. 평가 로직: `sources` AND `identities`; `sources` 내부에서 `accessLevel`/`resource`는 OR.

**검증 절차:** 고객이 dry-run으로 먼저 반영(`perimeters dry-run update --set-ingress-policies`) → 우리 테스트 호출이 ALLOWED인지 위반 분석기(`uid`/`troubleshootToken`)로 확인 → `perimeters dry-run enforce`로 승격. `--set-ingress-policies`는 인그레스 목록 전체를 교체하므로 describe 후 병합할 것.

## BigQuery / Antigravity

기본 토폴로지에서 Antigravity 텔레메트리는 조직 로그 싱크를 통해 **우리 중앙 프로젝트**의 BigQuery 데이터셋으로 흐르고 우리 SA가 그것을 조회한다. 따라서 고객은 Discovery Engine + Vertex AI만 부여하면 되고 BigQuery는 인그레스/역할 대상이 아니다. 고객이 자체 프로젝트에 텔레메트리 싱크를 두는 경우에만 `bigquery.googleapis.com`(인그레스 + `dataViewer`/`jobUser`)을 추가한다.

## 신원 전략

연결별 전용 서비스 계정(`nawa-conn-<name>@our-project`)을 권장한다(공유 SA 대비 침해 시 단일 고객 경계로 폭발 반경 한정). Cloud Run 연결 SA를 사용하므로 내보낸 키가 없다(온보딩 문서에 명시). DEV에서는 개발자 신원도 규칙에 넣거나 SA를 임퍼소네이션해 정확히 하나의 신원만 고정한다.

## 앱 대응 현황

- **Phase 1 (구현 완료):** [providers.py](../providers.py)가 `_http_get`에서 VPC-SC 403 본문(violation type·uid·troubleshootToken·service)을 파싱해 `VpcScDenied`로 올리고, [main.py](../main.py) `_err_fields`가 `error_type='vpc_sc'` + 한국어 안내로 분류하며, 프런트가 amber "온보딩 대기" 칩으로 구분 표시한다. 평범한 IAM 403은 기존대로 빨간 에러. 회귀 테스트: [tests/test_vpc_sc.py](../tests/test_vpc_sc.py).
- **Phase 3 (예정):** Antigravity/BigQuery 경로는 `google.api_core Forbidden`으로 오므로 별도 분류 확장 필요.
- **Phase 4 (예정):** Terraform으로 안정적 Cloud Run SA 이메일 출력(고객 인그레스 규칙이 키로 삼는 값), 선택적 연결별 SA 임퍼소네이션.

## 열린 질문 (고객별 확정 필요)

- DEV 신원을 Cloud Run SA로 통일할지(규칙에 넣을 신원 수 결정).
- 공유 SA vs 연결별 SA.
- 고객별 BigQuery 토폴로지(중앙 싱크 vs in-project 싱크).
- v1alpha 'list agents'가 `discoveryengine.viewer`로 되는지, editor가 필요한지.
- 메서드 수준 최소 권한: `discoveryengine`/`aiplatform`의 정확한 제한 가능 메서드 셀렉터.
- 고객 조직의 DRS 강제 여부 및 우리 Customer ID 허용 가능 여부(불가 시 Model B).

## 참고 문서

- [Ingress and egress rules](https://docs.cloud.google.com/vpc-service-controls/docs/ingress-egress-rules)
- [Configure identity groups and third-party identities in ingress and egress rules](https://docs.cloud.google.com/vpc-service-controls/docs/configure-identity-groups)
- [Context-aware access with ingress rules (source IP redaction)](https://docs.cloud.google.com/vpc-service-controls/docs/context-aware-access)
- [Configuring ingress and egress policies (gcloud)](https://docs.cloud.google.com/vpc-service-controls/docs/configuring-ingress-egress-policies)
- [Dry run mode for service perimeters](https://docs.cloud.google.com/vpc-service-controls/docs/dry-run-mode)
- [Diagnose an access denial in the violation analyzer](https://docs.cloud.google.com/vpc-service-controls/docs/violation-analyzer)
- [Restrict identities with domain-restricted sharing](https://docs.cloud.google.com/organization-policy/restrict-domains)
- [Sharing across perimeters with bridges (same-org only)](https://docs.cloud.google.com/vpc-service-controls/docs/share-across-perimeters)
- [Using VPC Service Controls | Cloud Run](https://docs.cloud.google.com/run/docs/securing/using-vpc-service-controls)
- [Secure your app with VPC Service Controls | Gemini Enterprise](https://docs.cloud.google.com/gemini/enterprise/docs/use-vpc-service-controls)
- [VPC Service Controls with Vertex AI](https://docs.cloud.google.com/vertex-ai/docs/general/vpc-service-controls)
