# Metric dictionary

Every number in LearnLens, what it means, how it is calculated, and which decision it supports.

**Terms used below**

- **Enrolment**: one learner in one course (the pair is created by the learner's first event in that course).
- **Attempt**: a session that ends in `course_passed` or `course_failed`.
- **First attempt**: the learner's first session in that course. Time metrics use it so retakes don't inflate them.

## Learner outcomes

| Metric | Definition | Calculation | Decision it supports |
|---|---|---|---|
| Active learners | Learners who did anything in a course in the period | Distinct learners with ≥1 event in the period | Is the training being used? |
| Completion rate | Share of enrolments that reached the end | Enrolments with `course_completed` or `course_passed` ÷ enrolments started in the period | Is the course finishable? |
| Mastery rate | Share of enrolments that passed **within 2 attempts** | Passed with ≤2 attempts ÷ enrolments started. Courses that never report pass/fail use first score ≥ 80% instead | Did learners actually learn it, or just click through? |
| At-risk learners | Learners matching any risk rule (below) in the period | Distinct learners | Who needs help now? |
| Typical completion time | Median first-attempt time of learners who completed | Sum of `page_viewed.duration_ms` in the first session, median | Is the course the length you designed? |
| Average score | Mean first score per learner | First `score_reported` (or pass/fail score) | Overall difficulty |

Trend charts group enrolments by the **week they started**. Recent weeks look lower because those learners haven't finished yet.

## Content quality

| Metric | Definition | Calculation | Decision it supports |
|---|---|---|---|
| Reached (funnel) | Share of learners who reached each section | Learners with `page_viewed` for the section ÷ learners who started | Where do people stop? |
| Biggest drop | The section learners most often leave on | Largest fall between consecutive funnel steps; the drop is attributed to the section learners *last viewed* | What to fix first |
| Time per section | Average first-attempt time spent per learner | Mean of per-learner sums of `duration_ms`, compared with the designed time you set | **Stuck** = >1.5× designed; **Rushed** = <0.75× designed |
| Drop-off | Started but never finished | 1 − completion rate | Course-level health |
| Correct (per question) | Share correct on the **first** answer | First answers per learner | Difficulty: Easy ≥80%, Medium 50–79%, Hard <50% |
| Discrimination | Do learners who do well on the *other* questions also get this one right? | Corrected item–rest point-biserial correlation (≥20 learners). Good ≥ 0.25, Fair 0.15–0.25, Poor < 0.15 | Questions that don't separate strong and weak learners measure luck, wording or untaught content |
| Answer breakdown | Share choosing each response | First answers | A wrong answer chosen by more people than the right one usually means confusing wording or teaching |
| Flags | Automatic warnings (≥10 responses) | **Likely confusing**: one wrong answer ≥40% and more popular than the correct one. **Too easy**: ≥90% correct. **Doesn't separate**: discrimination < 0.15 | What to rewrite |
| Version comparison | Metrics side by side for two course versions | Only learners who started ≥7 days ago, so the newer version isn't penalised for learners still in progress | Did the update help? Association only, not proof: use an A/B split to test causation |

## Skills and teams

| Metric | Definition | Calculation | Decision it supports |
|---|---|---|---|
| Progress by team | Mastered / completed-not-mastered / in progress or stopped | Enrolments started in the last 90 days, by learner team | Which teams are behind? |
| Competency heatmap | First-attempt accuracy on items tagged to each skill, per team | Correct first answers and successful decisions ÷ all, shown when ≥3 answers | Where is a team-wide skill gap? (Team training beats one-to-one follow-ups) |
| Learner competencies | The same, for one learner across all courses | — | Personal refresher; recommendations use skills with ≥3 answers |

## Risk and alert rules

All thresholds are editable on **Alerts & reports**.

| Rule | Default | Meaning |
|---|---|---|
| Stalled | 7 days | Not completed and no activity for 7–30 days |
| Repeated failure | 2 | Failed the final assessment at least twice and not yet passed |
| Rushing | 0.3 | Completed in under 30% of the course's typical time |
| Critical errors | 3 | At least 3 critical errors in a simulation |
| Confusing question | 0.5 | A wrong answer chosen by ≥50% (≥30 responses) and more often than the right one |
| Course went quiet | 3 days | A course that used to send data has sent nothing (often a broken package or LMS change) |

Alerts are de-duplicated: the same learner/course/rule raises one alert until it is resolved. Only activity from the last 14 days raises new learner alerts.

## What these numbers can't tell you

- **Correlation isn't causation.** A course version with better numbers may have had different learners or a different month.
- **Completion isn't competence.** That's why mastery and skill metrics exist, and why a practical observation still matters.
- **Small numbers are noisy.** Treat percentages based on fewer than ~30 learners as a hint, not a finding.
