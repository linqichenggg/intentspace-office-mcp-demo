export const messages = {
  ja: {
    no_activities:'予定を読み取れませんでした。日本語または英語で、仕事や会議の予定を入力してください。',ambiguous_date:'日付に複数の解釈があります。条件を補ってください。',ambiguous_time:'開始時刻が一意に決まりません。実際の時刻か時間帯を指定してください。',ambiguous_duration:'所要時間を一つに決めてください。',ambiguous_people:'参加する合計人数を一つに決めてください。',ambiguous_features:'必要な設備の選択条件を確認してください。',unparsed_constraint:'必須条件の一部を読み取れませんでした。「条件を補う」で確認してください。',
    notMyBooking:'この会議は自分で予約しない',registerAttendance:'参加先を登録（予約しない）',actualRoom:'参加する会議室',actualStart:'実際の開始時刻',chooseRoom:'会議室を選択してください',
    attending:'参加予定（他の人が予約）',attendanceSource:'本人申告の参加記録・予約操作なし',attendanceHint:'他の人が手配した会議室と開始時刻を入力します。新しい予約は作成しません。予約の存在・主催者は未確認です。',
    attendanceRegistered:'参加先を登録しました。新しい予約は作成していません。',withdrawAttendance:'参加予定を取り消す',attendanceRemoved:'自分の参加予定を取り消しました。他の人の予約は変更していません。',registerAgain:'参加先を登録し直す',
    invalid_attendance:'参加する会議室と開始時刻を確認してください。',attendance_conditions:'人数・所要時間・不明な条件を先に「条件を補う」で確認してください。',attendance_readonly:'これは参加記録です。予約の編集・削除・再予約はできません。社員画面で参加予定を操作してください。',
    attendance_registered:'参加先を登録（予約なし）',attendance_started:'参加を開始',attendance_completed:'参加を終了',attendance_cancelled:'参加予定を取消',
    rebook:'再予約の候補を探す',retrySuggestions:'空きを再検索',rebookHint:'この予約は取消済みです。空きを再検査し、新しい予約として確認できます。',rebookReady:'空きを再検査しました。候補を確認してから新しく予約してください。',
    allStates:'すべて',deleted:'削除済み',keyword:'議題・予約者を検索',newReservation:'予約を追加',editReservation:'予約を編集',deleteReservation:'削除',restoreReservation:'復元',saveReservation:'予約を保存',
    bookedBy:'予約者（表示名）',assignedTo:'社員Aとの関連',otherBooking:'他の人・システムの予約',employeeA:'社員Aの予定',presetSource:'システムの模擬予約',adminSource:'管理者が作成',employeeSource:'社員が作成',source:'登録元',
    adminLiveHint:'同じ模擬カレンダーを社員画面と共有します。システム予約を含めて検索・編集できます。',adminWriteBoundary:'本機の架空予約のみ変更します。企業データ・履歴CSVは読み取り専用。予約者名は表示用で、本人認証は行いません。',
    deleteHint:'予約を削除済みにして空き時間へ反映します。削除済みの絞り込みから復元できます。操作履歴は保持します。',restoreHint:'復元前に部屋と時刻の重複を再検査します。',
    reservationCreated:'模擬予約を追加しました。',reservationUpdated:'模擬予約を更新しました。',reservationDeleted:'模擬予約を削除しました。削除済み一覧から復元できます。',reservationRestored:'模擬予約を復元しました。',
    invalid_admin_query:'検索条件を確認してください。',invalid_admin_input:'入力内容と確認操作を確認してください。',invalid_room:'有効なスペースを選んでください。',record_changed:'別の操作で更新されています。最新の記録を開き直してください。',
    record_readonly:'編集できるのは予約済みの記録です。終了・取消済みの履歴は変更できません。',active_readonly:'会議中の記録は編集・削除できません。先に会議を終了してください。',capacity_exceeded:'人数が選択したスペースの定員を超えています。',equipment_missing:'選択したスペースは必要な設備を満たしていません。',operation_reused:'同じ操作IDで内容を変更できません。開き直してください。',preset_owner:'システム予約を社員Aの予定へ変更できません。',
    admin_create:'管理者が追加',admin_update:'管理者が更新',admin_delete:'管理者が削除',admin_restore:'管理者が復元',
    pre_cancelled:'事前キャンセル',post_cancelled:'事後キャンセル',unused_not_cancelled:'未利用・取消なし',
    dayPlan:'日程入力',view:'表示',api_limit:'OpenAIの利用上限または残高を確認してください。',api_network:'OpenAIに接続できません。接続を確認してください。',
    unresolved_constraints:'個人作業・外出などの不明な時間を先に補ってください。',duplicate_in_plan:'この計画内の同じ会議',viewOriginal:'元の提案を表示',
    employee:'社員',admin:'管理者',language:'表示言語',simulation:'架空オフィス / ローカル実験',settings:'API 設定',help:'使い方・制約',
    planTitle:'今日を、どう過ごしますか？',planHint:'仕事の流れをそのまま入力。相談が必要な予定だけ、空いている部屋を探します。',
    planLabel:'1日の予定（日本語・英語）',planPlaceholder:'午前は資料作成に集中します。午後に4人で45分、モニターを使って企画を相談したいです。15:00から18:00は別の予定があります。',
    example:'入力例を使う',analyse:'予定を整理する',analysing:'予定と既存の会議を確認しています…',rules:'ローカル解析',gpt:'GPT 解析',
    noKey:'GPT 未接続',withKey:'GPT 接続済み',modeHelp:'ローカル解析は限られた表現に対応。GPTは複数の予定や柔軟な条件を読み取ります。',
    gptUse:'GPT：予定の理解・不足情報の整理。ルール：重複・空き・状態の検証。',ready:'予定を入力してください。予約は確認するまで作成しません。',
    mapTitle:'オフィス',mapNote:'位置は演出です。開始ボタンで入室を模擬します。',focusArea:'個人作業',meetingArea:'ミーティング',reception:'受付',entry:'入口',
    roomC:'4人 / モニター・白板・静音',roomM:'6人 / モニター・オンライン会議',seatF:'1人 / モニター・静音',
    available:'未使用',reserved:'予約済み',in_progress:'会議中',completed:'終了',cancelled:'取消済み',candidate:'提案',
    idle:'受付',working:'会議中',simClock:'模擬時刻',agenda:'会議の予定',proposals:'提案',bookings:'予約・実施',empty:'まだ予定はありません。',
    noPlan:'入力した計画から、必要な会議を整理します。',of:'件',previous:'前へ',next:'次へ',details:'詳細・根拠',confirm:'この内容で予約',
    start:'会議を開始（模擬）',finish:'会議を終了（模擬）',cancel:'予約を取り消す',edit:'条件を補う',existing:'既存の会議です',possible_duplicate:'同じ会議か確認',
    proposed:'確認待ち',needs_input:'追加情報が必要',no_slot:'空き時間・部屋がありません',note:'予約不要の予定',
    reuse:'既存の会議を使う',distinct:'別の会議として探す',reused:'既存の会議を表示しました。追加予約はありません。',
    booked:'予約しました。開始するまでは小人は移動しません。',started:'開始イベントを受信。部屋を会議中に更新しました。',ended:'終了イベントを受信。小人が受付に戻りました。',cancelDone:'予約を取り消しました。',
    people:'合計人数',duration:'所要時間（分）',date:'日付',time:'開始時刻',windowStart:'開始可能時刻',windowEnd:'終了期限',title:'議題・目的',features:'必要な設備',
    exact:'時刻指定',flexible:'時間帯から探す',save:'条件を更新して再検索',close:'閉じる',connectionTitle:'GPT 接続',model:'GPT モデル名',key:'OpenAI API Key',
    configure:'このページで使う',clear:'Key を消去',keyCleared:'Key を消去しました。',keyReady:'このページでのみ有効です。GPT解析を選択しました。',
    privacy:'GPT送信時に料金が発生します。入力計画と、この架空ワークスペースの既存会議の要約を送信します。機密情報は入力しないでください。Keyはページメモリのみで保持し、再読み込み・離脱で消去します。',
    boundary:'架空データのみ。社員Aの共有ワークスペース。予約は再読み込み後も残り、サーバー再起動で消えます。管理者切替は認証ではありません。',
    helpText:'09:00〜18:00、JSTの今日から30日先まで。起動時はC-04の14:00〜15:00、M-02の11:00〜12:00、F-12の10:00〜11:00に初期の模擬予約を設定します。現在の予約は管理画面で確認・編集・削除できます。削除・リセット済みの初期予約は、その実行中は自動生成し直しません。会議開始は予定時刻への模擬チェックイン、終了は予定終了時刻への模擬チェックアウトです。実際の時計・入館・出席者の在席とは連動しません。会議中は取消不可、終了してください。参加者の予定や同意は未接続です。既存の会議は自動変更しません。',
    monitor:'モニター',whiteboard:'白板',quiet:'静かな場所',video:'オンライン会議',projector:'プロジェクター',window:'窓際',
    missing_duration:'所要時間を指定してください。',missing_people:'参加する合計人数を指定してください。',missing_window:'開始時刻か、開始可能時刻と終了期限を指定してください。',
    input_length:'1〜4,000文字で予定を入力してください。',language_only:'日本語または英語で入力してください。',too_many_items:'1回の入力は12項目までです。',
    invalid_plan:'解析結果の形式が無効です。予定を短くして再入力してください。',date_range:'日付は今日から30日先までです。',invalid_window:'時間帯の開始は終了より前にしてください。',hours:'利用時間は09:00〜18:00です。',
    plan_expired:'提案が失効しました。予定をもう一度整理してください。',confirmation_required:'予約内容の確認が必要です。',invalid_proposal:'提案が無効です。再検索してください。',
    cancelled_replan:'取消済みの予約です。予定を再検索してください。',changed_selection:'確定済みの部屋は変更できません。',workspace_limit:'このワークスペースは200件までです。',
    personal_conflict:'社員Aの別の予定と重なります。再検索してください。',state_changed:'予約状況が変わりました。再検索してください。',room_conflict:'部屋の予約が重なりました。再検索してください。',
    meeting_missing:'会議が見つかりません。',invalid_transition:'この状態ではその操作はできません。',already_in_meeting:'別の会議が進行中です。先に終了してください。',invalid_end:'終了時刻を確認してください。',
    invalid_action:'操作が無効です。',invalid_mode:'解析方式を確認してください。',invalid_model:'モデル名を確認してください。',model_output:'GPTの解析結果を検証できませんでした。新しい予約は作成していません。内容を確認して再試行してください。',
    genericError:'処理に失敗しました。接続・設定を確認して再試行してください。',keyRequired:'API設定でKeyを入力してください。',busy:'処理中…',refresh:'更新',
    live:'現在の模擬オフィス',summary:'予約と利用',spaces:'スペース一覧',reservations:'予約明細',review:'未利用の確認',ai:'AI に質問',
    liveDesc:'社員の操作と同じ状態を表示。表示中は5秒ごとに同期します。',historyDesc:'2026年2月の固定架空サンプル。今日の模擬予約とは別のデータです。',
    total:'予約総数',active:'会議中',endedCount:'終了件数',cancelledCount:'取消件数',room:'スペース',state:'状態',startAt:'開始',endAt:'終了',
    query:'照会する',search:'名前で検索',startDate:'開始日',endDate:'終了日',minimum:'最小予約数',unusedMin:'最小未利用件数',percent:'最小未利用割合（%）',
    raw:'実際の MCP 呼び出し',noRows:'記録がありません。',used:'利用済み',unused:'未利用',eligible:'対象件数',reviewCount:'確認候補',
    reviewLabel:'確認候補',below_threshold:'閾値未満',insufficient_data:'サンプル不足',unknown:'不明',runReview:'ルールで確認',evidence:'参照元',
    adminAi:'データに質問する',askHint:'2026年2月の予約をスペース別に集計してください。',send:'質問を送る',aiNote:'架空の履歴サンプルを照会します。今日の模擬予約はこのAI照会の対象外です。',
    aiEmpty:'質問と根拠をここに表示します。',answer:'回答',page:'ページ',showEvents:'イベント履歴',event:'操作',at:'受信時刻',
    setup:'接続設定を開く',reload:'再読み込み',focus:'個人作業',unavailable:'別の予定',meeting:'会議',no_slot_help:'人数・設備・時間帯、または他の予定との重なりを確認してください。',
    seed:'既存模擬予約',needsReview:'解釈を確認してください。',unknownFeature:'対応情報なし',analysisDone:'計画を整理しました。各提案を確認してください。',
    footer:'企業API・実定位は未接続 / 開始・終了は明示的な模擬イベント',currentDate:'基準日',status:'状況',
    comparison:'前回との比較',baseline:'比較基準を作成',compared:'同じ条件の前回結果と比較',incomparable:'条件が違うため比較しません',new:'新規',ongoing:'継続',no_longer_matches:'条件未達',uncertain:'判断保留',unchanged:'変化なし',
    reviewDemo:'変化を試す',demoNext:'次の架空バッチ',demoReset:'最初から',demoDesc:'独立した4段階の架空データをMCPで照会します。通常の検索条件は変更しません。',
    sample:'入力例',traceNote:'MCPの返却値は元の形式です。画面の表示言語を切り替えても、原データは翻訳・変更しません。'
  },
  en: {
    no_activities:'No plan could be extracted. Describe your work or meetings in Japanese or English.',ambiguous_date:'The date has conflicting interpretations. Edit the conditions.',ambiguous_time:'The start time is ambiguous. Specify the actual time or a time window.',ambiguous_duration:'Specify a single duration.',ambiguous_people:'Specify a single total number of participants.',ambiguous_features:'Clarify the equipment alternatives.',unparsed_constraint:'A mandatory requirement could not be interpreted. Review it in Edit conditions.',
    notMyBooking:'Someone else is booking this meeting',registerAttendance:'Save attendance (no booking)',actualRoom:'Meeting room to attend',actualStart:'Actual start time',chooseRoom:'Choose the meeting room',
    attending:'Attending · booked by someone else',attendanceSource:'Self-reported attendance · no booking made',attendanceHint:'Enter the room and start time arranged by someone else. No new booking is created. The external booking and organiser are unverified.',
    attendanceRegistered:'Attendance saved. No new booking was created.',withdrawAttendance:'Withdraw my attendance',attendanceRemoved:'Your attendance was withdrawn. Other people’s bookings were not changed.',registerAgain:'Register attendance again',
    invalid_attendance:'Check the meeting room and actual start time.',attendance_conditions:'Use Edit conditions to complete the people, duration and unresolved requirements first.',attendance_readonly:'This is an attendance record. Booking edits, deletion and rebooking are unavailable. Manage attendance in the employee view.',
    attendance_registered:'Attendance registered (no booking)',attendance_started:'Attendance started',attendance_completed:'Attendance ended',attendance_cancelled:'Attendance withdrawn',
    rebook:'Find rooms to book again',retrySuggestions:'Search availability again',rebookHint:'This booking was cancelled. Check availability and confirm a new booking.',rebookReady:'Availability checked again. Review the suggestion before confirming a new booking.',
    allStates:'All',deleted:'Deleted',keyword:'Search topic or booker',newReservation:'Add booking',editReservation:'Edit booking',deleteReservation:'Delete',restoreReservation:'Restore',saveReservation:'Save booking',
    bookedBy:'Booked by (display name)',assignedTo:'Related to employee A',otherBooking:'Another person or system',employeeA:'Employee A’s schedule',presetSource:'System demo booking',adminSource:'Created by admin',employeeSource:'Created by employee',source:'Source',
    adminLiveHint:'Shared with the employee view. Search and edit the same fictional calendar, including seeded bookings.',adminWriteBoundary:'Changes affect this local fictional calendar only. Enterprise data and historical CSVs remain read-only. Booker names are labels, not authenticated identities.',
    deleteHint:'Mark this booking as deleted and release its time slot. Restore it using the Deleted filter. The event log is retained.',restoreHint:'Room and time conflicts are checked again before restoring.',
    reservationCreated:'Simulated booking added.',reservationUpdated:'Simulated booking updated.',reservationDeleted:'Simulated booking deleted. Restore it from the Deleted list.',reservationRestored:'Simulated booking restored.',
    invalid_admin_query:'Check your search filters.',invalid_admin_input:'Check the booking fields and confirm the action.',invalid_room:'Choose a valid space.',record_changed:'This record changed elsewhere. Reopen the latest version.',record_readonly:'Only reserved records can be edited. Completed and cancelled history is read-only.',active_readonly:'End the in-progress meeting before editing or deleting it.',capacity_exceeded:'The number of people exceeds this space’s capacity.',equipment_missing:'This space does not provide all required equipment.',operation_reused:'The operation ID was reused with different content. Reopen the form.',preset_owner:'A system booking cannot be reassigned to employee A.',
    admin_create:'Created by admin',admin_update:'Updated by admin',admin_delete:'Deleted by admin',admin_restore:'Restored by admin',
    pre_cancelled:'Cancelled before start',post_cancelled:'Cancelled after start',unused_not_cancelled:'Unused, not cancelled',
    dayPlan:'Plan',view:'View',api_limit:'Check your OpenAI account balance or rate limit.',api_network:'Could not connect to OpenAI. Check your connection.',
    unresolved_constraints:'First complete the times for focus work or unavailable periods.',duplicate_in_plan:'Repeated meeting in this plan',viewOriginal:'View original suggestion',
    employee:'Employee',admin:'Admin',language:'Language',simulation:'Fictional office / Local prototype',settings:'API settings',help:'Guide & limits',
    planTitle:'What does your day look like?',planHint:'Describe your working day. We find space for the conversations that need a room.',planLabel:'Your day (Japanese or English)',
    planPlaceholder:'I will focus on documentation in the morning. In the afternoon I need a 45-minute project meeting for 4 people with a monitor. I am unavailable from 15:00 to 18:00.',
    example:'Use an example',analyse:'Organise my day',analysing:'Reading your plan and checking existing meetings…',rules:'Local parser',gpt:'GPT parser',noKey:'GPT not connected',withKey:'GPT connected',
    modeHelp:'Local parsing supports limited wording. GPT understands multiple activities and flexible constraints.',gptUse:'GPT interprets plans. Rules validate duplicates, availability and meeting states.',ready:'Describe your day. No booking is made until you confirm.',
    mapTitle:'The office',mapNote:'Illustrated positions. Start a meeting to simulate entry.',focusArea:'Focus area',meetingArea:'Meeting area',reception:'Reception',entry:'Entry',roomC:'4 people / Monitor, board, quiet',roomM:'6 people / Monitor, video',seatF:'1 person / Monitor, quiet',
    available:'Not in use',reserved:'Reserved',in_progress:'In progress',completed:'Completed',cancelled:'Cancelled',candidate:'Suggested',idle:'Reception',working:'In a meeting',simClock:'Simulated time',agenda:'Your meetings',proposals:'Suggestions',bookings:'Bookings & activity',empty:'No meetings yet.',
    noPlan:'Your meeting suggestions will appear here.',of:'items',previous:'Previous',next:'Next',details:'Details & evidence',confirm:'Confirm booking',start:'Start meeting (simulate)',finish:'End meeting (simulate)',cancel:'Cancel booking',edit:'Edit conditions',existing:'Already arranged',possible_duplicate:'Possible duplicate',
    proposed:'Awaiting confirmation',needs_input:'More information needed',no_slot:'No suitable slot or room',note:'No room booking needed',reuse:'Use existing meeting',distinct:'Find a separate meeting',reused:'Showing the existing meeting. No extra booking was created.',booked:'Booked. The employee stays put until the meeting starts.',started:'Start event received. The room is now in use.',ended:'End event received. The employee returned to reception.',cancelDone:'Booking cancelled.',
    people:'Total people',duration:'Duration (minutes)',date:'Date',time:'Start time',windowStart:'Earliest start',windowEnd:'Finish by',title:'Topic or purpose',features:'Required equipment',exact:'Exact start',flexible:'Find a slot',save:'Update & search again',close:'Close',connectionTitle:'Connect GPT',model:'GPT model',key:'OpenAI API Key',configure:'Use on this page',clear:'Clear Key',keyCleared:'Key cleared.',keyReady:'Available on this page only. GPT parsing selected.',
    privacy:'GPT requests incur API charges. We send your plan and summaries of existing meetings in this fictional workspace. Do not enter confidential information. The Key is held only in page memory and cleared on reload or exit.',boundary:'Fictional data. One shared workspace for employee A. Bookings survive reloads and reset when the server restarts. Admin view switching is not authentication.',
    helpText:'09:00–18:00, today through 30 days ahead in JST. At startup, daily seeded bookings are C-04 14:00–15:00, M-02 11:00–12:00 and F-12 10:00–11:00. View, edit or delete current bookings in Admin. Deleted or reset seeds do not reappear during that server run. Start simulates check-in at the scheduled start; end simulates check-out at the scheduled end. No link to the real clock, access events or participant presence. End an in-progress meeting before cancelling other activity. Participant calendars and consent are not connected. Existing meetings are never changed automatically.',
    monitor:'Monitor',whiteboard:'Whiteboard',quiet:'Quiet space',video:'Video conferencing',projector:'Projector',window:'Window seat',missing_duration:'Specify the duration.',missing_people:'Specify the total number of participants.',missing_window:'Specify an exact start or an earliest start and finish-by time.',
    input_length:'Enter a plan of 1–4,000 characters.',language_only:'Please use Japanese or English.',too_many_items:'Use at most 12 activities per plan.',invalid_plan:'The parsed plan is invalid. Try shorter wording.',date_range:'Choose today through 30 days ahead.',invalid_window:'The time window must end after it starts.',hours:'Office hours are 09:00–18:00.',plan_expired:'This suggestion expired. Organise your day again.',confirmation_required:'Confirm the booking details first.',invalid_proposal:'This suggestion is invalid. Search again.',cancelled_replan:'This booking was cancelled. Search for a new suggestion.',changed_selection:'The confirmed room cannot be changed here.',workspace_limit:'This demo workspace is limited to 200 meetings.',personal_conflict:'This overlaps another meeting for employee A. Search again.',state_changed:'Bookings changed. Search again.',room_conflict:'The room is no longer available. Search again.',meeting_missing:'Meeting not found.',invalid_transition:'This action is not available in the current state.',already_in_meeting:'Another meeting is in progress. End it first.',invalid_end:'Check the end time.',invalid_action:'Invalid action.',invalid_mode:'Check the parsing mode.',invalid_model:'Check the model name.',model_output:'GPT output could not be validated. No new booking was made. Review your plan and retry.',genericError:'The operation failed. Check your connection and settings, then retry.',keyRequired:'Enter your Key in API settings.',busy:'Working…',refresh:'Refresh',
    live:'Live simulation',summary:'Bookings & use',spaces:'Spaces',reservations:'Booking records',review:'Unused bookings',ai:'Ask AI',liveDesc:'Same state as the employee view. Syncs every 5 seconds while visible.',historyDesc:'Fixed fictional sample from February 2026. Separate from today’s simulated bookings.',total:'Total bookings',active:'In progress',endedCount:'Completed',cancelledCount:'Cancelled',room:'Space',state:'State',startAt:'Start',endAt:'End',query:'Run query',search:'Search by name',startDate:'From',endDate:'To',minimum:'Minimum bookings',unusedMin:'Minimum unused',percent:'Minimum unused (%)',raw:'Actual MCP calls',noRows:'No records.',used:'Used',unused:'Unused',eligible:'Eligible',reviewCount:'Review candidates',reviewLabel:'Review candidate',below_threshold:'Below threshold',insufficient_data:'Insufficient sample',unknown:'Unknown',runReview:'Check with rules',evidence:'Source evidence',adminAi:'Ask about the data',askHint:'Summarise bookings by space for February 2026.',send:'Send question',aiNote:'Queries fictional historical data. Today’s simulated bookings are not included in this AI query.',aiEmpty:'Your answer and evidence will appear here.',answer:'Answer',page:'Page',showEvents:'Event log',event:'Event',at:'Received at',setup:'Open connection settings',reload:'Reload',focus:'Focus work',unavailable:'Unavailable',meeting:'Meeting',no_slot_help:'Check capacity, equipment, time window and other commitments.',seed:'Seeded booking',needsReview:'Review this interpretation.',unknownFeature:'No supporting data',analysisDone:'Your plan is ready for review.',footer:'No enterprise API or real positioning / Start and end are explicit simulated events',currentDate:'Reference date',status:'Status',
    comparison:'Compare with previous',baseline:'Comparison baseline created',compared:'Compared with the same previous conditions',incomparable:'Different conditions; no comparison',new:'New',ongoing:'Ongoing',no_longer_matches:'Below threshold now',uncertain:'Uncertain',unchanged:'Unchanged',reviewDemo:'Try a change',demoNext:'Next fictional batch',demoReset:'Restart',demoDesc:'Queries four isolated fictional batches through MCP without changing normal query conditions.',sample:'Example',traceNote:'MCP responses retain their original format. Switching the interface language does not translate or modify source data.'
  }
};

export function translator(locale) {
  return key => messages[locale]?.[key] ?? messages.ja[key] ?? key;
}

export function reservationStatusLabel(record, locale) {
  const t=translator(locale);
  const key={'事前キャンセル':'pre_cancelled','事後キャンセル':'post_cancelled','未利用・キャンセルなし':'unused_not_cancelled'}[record.status];
  return t(key??(record.is_used===true?'used':'unknown'));
}

export function applyLanguage(locale, root = document) {
  const t = translator(locale);
  document.documentElement.lang = locale;
  root.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n);});
  root.querySelectorAll('[data-placeholder]').forEach(el=>{el.placeholder=t(el.dataset.placeholder);});
  root.querySelectorAll('[data-label]').forEach(el=>{el.setAttribute('aria-label',t(el.dataset.label));});
}
