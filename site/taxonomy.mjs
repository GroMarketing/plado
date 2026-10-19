// Plado use-case taxonomy: team → task, plus industry.
// Modeled on how Zapier and the Shopify App Store group apps by team, and how Salesforce
// AppExchange and Microsoft AppSource add industry. Classification is deterministic keyword
// rules over name + description (no AI calls), so it's cheap, repeatable and auditable.
// `re`  = what in a listing's text puts it in the task (precision first: ambiguous words are left out)
// `q`   = phrases people type in search that mean this task (used by the query parser in app.js)

const T = (label, re, q = []) => ({ label, re, q });

export const TEAMS = {
  engineering: {
    label: 'Engineering', q: ['engineering', 'developer', 'developers', 'coding', 'programming', 'software'],
    tasks: {
      'code-review': T('Code review', /\b(code reviews?|review (code|prs?|pull requests?|changes|diffs?)|reviewers?)\b/i, ['code review', 'review code', 'review my code', 'pr review', 'review prs']),
      testing: T('Testing & QA', /\b(tests?|testing|tdd|e2e|unit tests?|jest|pytest|vitest|playwright|cypress|qa)\b/i, ['testing', 'tests', 'write tests', 'unit tests', 'e2e', 'qa', 'tdd']),
      debugging: T('Debugging', /\b(debug\w*|bugs?|stack traces?|troubleshoot\w*|root cause|crash\w*)\b/i, ['debug', 'debugging', 'fix bugs', 'bug', 'bugs', 'errors']),
      refactoring: T('Refactoring', /\b(refactor\w*|clean code|tech(nical)? debt|legacy code|moderniz\w+|code migrations?)\b/i, ['refactor', 'refactoring', 'clean code', 'tech debt', 'legacy code']),
      frontend: T('Frontend', /\b(frontend|front-end|react|vue|svelte|angular|next\.?js|nuxt|tailwind|css)\b/i, ['frontend', 'front end', 'react', 'vue', 'nextjs', 'next.js', 'tailwind', 'css']),
      backend: T('Backend & APIs', /\b(backend|back-end|rest api|graphql|api design|fastapi|django|rails|spring boot|express\.?js)\b/i, ['backend', 'api', 'apis', 'rest api', 'graphql']),
      databases: T('Databases', /\b(databases?|sql|postgres\w*|mysql|sqlite|mongo\w*|supabase|redis|prisma|drizzle|dynamodb|clickhouse)\b/i, ['database', 'databases', 'sql', 'postgres', 'mysql', 'supabase', 'mongodb']),
      devops: T('DevOps & cloud', /\b(deploy\w*|ci\/cd|github actions|docker|kubernetes|k8s|helm|terraform|infrastructure|aws|gcp|azure|vercel|cloudflare|netlify|observability|monitoring|sentry|grafana|datadog)\b/i, ['devops', 'deploy', 'deployment', 'docker', 'kubernetes', 'aws', 'cloud', 'ci/cd', 'infrastructure', 'monitoring']),
      mobile: T('Mobile apps', /\b(ios|android|swift ?ui|kotlin|react native|flutter|expo|mobile apps?)\b/i, ['mobile', 'ios', 'android', 'mobile app', 'flutter', 'react native']),
      git: T('Git & GitHub', /\b(git|github|gitlab|bitbucket|pull requests?|commit messages?|merge conflicts?)\b/i, ['git', 'github', 'gitlab', 'commits', 'pull requests']),
      docs: T('Documentation', /\b(documentation|readmes?|docstrings?|api docs|technical writing|changelogs?)\b/i, ['documentation', 'docs', 'readme', 'changelog']),
      architecture: T('Architecture', /\b(software architecture|system design|design patterns?|domain-driven|ddd|microservices|monorepos?)\b/i, ['architecture', 'system design', 'design patterns', 'microservices']),
      'ai-engineering': T('AI engineering', /\b(rag|embeddings?|vector (db|database|store)s?|langchain|llamaindex|langgraph|fine-?tun\w+|prompt engineering|evals?|llm (apps?|applications|evaluation|observability))\b/i, ['llm', 'rag', 'embeddings', 'prompt engineering', 'fine tuning', 'evals', 'ai engineering']),
    },
  },
  security: {
    label: 'Security', q: ['security', 'secure', 'appsec'],
    tasks: {
      'security-review': T('Security review', /\b(security|vulnerabilit\w+|owasp|pentest\w*|penetration test\w*|threat model\w*|secrets? scan\w*|cves?|sast|dast|malware)\b/i, ['security review', 'vulnerabilities', 'pentest', 'owasp', 'security audit', 'threat model']),
      compliance: T('Compliance', /\b(compliance|gdpr|soc ?2|hipaa|pci(-dss)?|iso 27001|audit trails?)\b/i, ['compliance', 'gdpr', 'soc 2', 'hipaa']),
    },
  },
  data: {
    label: 'Data & analytics', q: ['data', 'analytics', 'analyst', 'data science'],
    tasks: {
      analytics: T('Analytics & dashboards', /\b(analytics|dashboards?|metrics|kpis?|business intelligence|google analytics|ga4|mixpanel|amplitude|posthog)\b/i, ['analytics', 'dashboard', 'dashboards', 'metrics', 'kpis', 'reporting']),
      'data-engineering': T('Data pipelines', /\b(etl|elt|data pipelines?|dbt|spark|airflow|dagster|data warehouses?|bigquery|snowflake|databricks)\b/i, ['etl', 'data pipeline', 'dbt', 'bigquery', 'snowflake', 'data warehouse']),
      spreadsheets: T('Spreadsheets', /\b(excel|xlsx|spreadsheets?|google sheets|csv)\b/i, ['excel', 'spreadsheet', 'spreadsheets', 'google sheets', 'csv']),
      'machine-learning': T('Machine learning', /\b(machine learning|ml models?|model training|pandas|numpy|scikit|pytorch|tensorflow|jupyter|kaggle)\b/i, ['machine learning', 'ml', 'pandas', 'jupyter', 'pytorch', 'data science']),
    },
  },
  product: {
    label: 'Product', q: ['product', 'product manager', 'pm'],
    tasks: {
      specs: T('Specs & roadmaps', /\b(prds?|product requirements?|roadmaps?|user stor(y|ies)|product manag\w+|product specs?|feature specs?)\b/i, ['prd', 'product requirements', 'roadmap', 'user stories', 'specs']),
      'user-research': T('User research', /\b(user research|user interviews?|surveys?|customer feedback|usability test\w*|user personas?|buyer personas?)\b/i, ['user research', 'interviews', 'survey', 'surveys', 'feedback', 'personas']),
      'project-management': T('Project management', /\b(jira|linear(?! (algebra|regression))|asana|trello|clickup|monday\.com|project management|sprints?|kanban)\b/i, ['project management', 'jira', 'linear', 'asana', 'trello', 'tickets', 'sprint']),
    },
  },
  design: {
    label: 'Design', q: ['design', 'designer', 'ui', 'ux'],
    tasks: {
      'ui-design': T('UI design', /\b(figma|design systems?|ui design|ux design|ui (and|&) ux|design references?|mockups?|wireframes?|prototyp\w+|ui\/ux|shadcn|design tokens?)\b/i, ['ui design', 'figma', 'design system', 'mockup', 'wireframe', 'prototype']),
      accessibility: T('Accessibility', /\b(accessibility(?! api)|a11y|wcag|screen readers?)\b/i, ['accessibility', 'a11y', 'wcag']),
    },
  },
  marketing: {
    label: 'Marketing', q: ['marketing', 'marketer', 'marketers', 'growth marketing'],
    tasks: {
      strategy: T('Marketing strategy', /\b(marketing (strateg\w+|plans?|campaigns?)|digital marketing|go-to-market|gtm strateg\w+|marketing agents?)\b/i, ['marketing strategy', 'marketing plan', 'digital marketing', 'go to market', 'gtm']),
      'social-media': T('Social media', /\b(social media|social posts?|twitter|tweets?|x\.com|linkedin posts?|instagram|tiktok|facebook|bluesky|reddit posts?|youtube shorts|reels|schedul\w+ posts?|hootsuite|typefully)\b/i, ['social media', 'social', 'post', 'posts', 'posting', 'publish posts', 'tweet', 'tweets', 'twitter', 'linkedin', 'instagram', 'tiktok', 'facebook', 'threads', 'bluesky', 'reddit', 'schedule posts']),
      seo: T('SEO', /\b(seo|search engine optimi[sz]ation|keyword research|serps?|backlinks?|meta descriptions?|schema markup|search console)\b/i, ['seo', 'search engine optimization', 'keywords', 'keyword research', 'backlinks', 'rank on google']),
      ads: T('Ads', /\b(ads|ad copy|ppc|google ads|meta ads|facebook ads|linkedin ads|ad campaigns?|advertis\w+)\b/i, ['ads', 'advertising', 'google ads', 'facebook ads', 'meta ads', 'ppc', 'ad copy']),
      'email-marketing': T('Email & newsletters', /\b(newsletters?|email (marketing|campaigns?|sequences?)|mailchimp|klaviyo|beehiiv|convertkit|cold emails?)\b/i, ['email marketing', 'newsletter', 'newsletters', 'email campaign', 'mailchimp', 'cold email']),
      content: T('Content & copywriting', /\b(content (marketing|strategy|calendar|plan)|blog posts?|copywrit\w+|landing pages?|marketing copy|product descriptions?)\b/i, ['content', 'copywriting', 'copy', 'blog posts', 'landing page', 'content calendar', 'content marketing']),
      brand: T('Brand & positioning', /\b(brand (voice|identity|guidelines|strategy)|(brand|market|product) positioning|messaging framework|taglines?)\b/i, ['brand', 'branding', 'positioning', 'brand voice', 'messaging']),
      growth: T('Growth & conversion', /\b(conversion rates?|cro|a\/b tests?|funnels?|(user|customer) retention|product-led|growth hack\w*)\b/i, ['growth', 'conversion', 'a/b test', 'funnel', 'cro', 'retention']),
    },
  },
  sales: {
    label: 'Sales', q: ['sales', 'selling', 'sdr', 'account executive'],
    tasks: {
      prospecting: T('Prospecting & leads', /\b(prospect\w*|lead gen\w*|leads|lead lists?|sales outreach|cold (calls?|outreach)|apollo\.io|(lead|contact) enrichment|sdrs?)\b/i, ['prospecting', 'leads', 'lead generation', 'outreach', 'find leads', 'cold outreach']),
      crm: T('CRM', /\b(crm|salesforce|hubspot|pipedrive|attio|deal pipelines?)\b/i, ['crm', 'salesforce', 'hubspot', 'pipedrive']),
      proposals: T('Proposals & decks', /\b(proposals?|rfps?|sales decks?|pitch decks?)\b/i, ['proposal', 'proposals', 'rfp', 'sales deck', 'pitch deck']),
    },
  },
  support: {
    label: 'Customer support', q: ['support', 'customer support', 'customer service', 'helpdesk'],
    tasks: {
      'customer-support': T('Support & helpdesk', /\b(customer support|customer service|help ?desk|zendesk|intercom|freshdesk|support tickets?|faqs?|chatbots?)\b/i, ['customer support', 'support tickets', 'helpdesk', 'zendesk', 'intercom', 'chatbot', 'faq']),
    },
  },
  creative: {
    label: 'Content & media', q: ['creator', 'creative', 'content creator', 'media'],
    tasks: {
      writing: T('Writing & editing', /\b(blog|articles?|essays?|fiction|novels?|copywrit\w+|proofread\w*|grammar check\w*|ghostwrit\w+|long-?form|writing assistant|storytelling)\b/i, ['writing', 'write', 'editing', 'blog', 'article', 'essay', 'proofread', 'story']),
      video: T('Video', /\b(video|videos|remotion|youtube|ffmpeg|subtitles|captions|shorts)\b/i, ['video', 'videos', 'youtube', 'remotion', 'video editing', 'captions', 'shorts']),
      image: T('Images', /\b(image generation|generate images?|text-to-image|midjourney|stable diffusion|dall-?e|flux|image editing|photos?|thumbnails?|comfyui|nano banana)\b/i, ['image', 'images', 'image generation', 'midjourney', 'photos', 'thumbnails']),
      audio: T('Audio, voice & music', /\b(audio|podcasts?|music|suno|text-to-speech|tts|speech|transcri\w+|voice ?overs?|elevenlabs|whisper)\b/i, ['audio', 'podcast', 'music', 'voice', 'text to speech', 'transcribe', 'transcription']),
      presentations: T('Slides & presentations', /\b(slides?|presentations?|pptx|powerpoint|keynote|pitch decks?)\b/i, ['slides', 'presentation', 'presentations', 'powerpoint', 'deck']),
    },
  },
  operations: {
    label: 'Operations', q: ['operations', 'ops', 'admin', 'back office'],
    tasks: {
      automation: T('Workflow automation', /\b(n8n|zapier|make\.com|ifttt|rpa|business automation|automate (tasks|workflows|emails|reports))\b/i, ['automation', 'automate', 'workflow automation', 'n8n', 'zapier']),
      documents: T('Documents & PDFs', /\b(pdfs?|docx|word documents?|ocr|document processing)\b/i, ['pdf', 'pdfs', 'documents', 'docx', 'ocr']),
      communication: T('Email, chat & calendar', /\b(slack|discord|microsoft teams|gmail|outlook|inbox|calendars?|meetings?)\b/i, ['slack', 'discord', 'email', 'gmail', 'calendar', 'meetings', 'inbox']),
      knowledge: T('Notes & knowledge base', /\b(notion|obsidian|confluence|wikis?|knowledge bases?|second brain|note-?taking|notes apps?|meeting notes|personal notes)\b/i, ['notion', 'obsidian', 'notes', 'knowledge base', 'wiki', 'confluence']),
    },
  },
  finance: {
    label: 'Finance', q: ['finance', 'financial', 'accountant', 'cfo'],
    tasks: {
      accounting: T('Accounting & invoices', /\b(accounting|bookkeeping|invoices?|invoicing|quickbooks|xero|expenses?|receipts?|tax(es)?)\b/i, ['accounting', 'bookkeeping', 'invoices', 'invoice', 'expenses', 'taxes']),
      trading: T('Trading & investing', /\b(trading|stocks?|crypto(currenc(y|ies))?|portfolios?|market data|invest(ing|ment|ments|ors?)?|forex|defi|blockchain)\b/i, ['trading', 'stocks', 'crypto', 'investing', 'portfolio']),
      fpa: T('Planning & modeling', /\b(financial models?|forecast\w*|budgeting|financial budgets?|valuation|dcf|cash flow|financial statements?)\b/i, ['financial model', 'forecast', 'budget', 'valuation']),
    },
  },
  people: {
    label: 'HR & recruiting', q: ['hr', 'recruiting', 'recruiter', 'hiring', 'people ops'],
    tasks: {
      recruiting: T('Recruiting & job search', /\b(recruit\w*|hiring|resumes?|job descriptions?|candidates?|interview prep|job search|cover letters?)\b/i, ['recruiting', 'hiring', 'resume', 'job description', 'candidates', 'job search', 'cover letter']),
      hr: T('HR', /\b(human resources|onboarding employees|employee handbook|payroll|performance reviews?)\b/i, ['hr', 'human resources', 'payroll', 'performance review', 'employee onboarding']),
    },
  },
  legal: {
    label: 'Legal', q: ['legal', 'lawyer', 'law'],
    tasks: {
      legal: T('Contracts & policies', /\b(legal|contract review|terms of service|privacy polic(y|ies)|ndas?|lawyers?)\b/i, ['legal', 'contract', 'contracts', 'nda', 'privacy policy', 'terms of service']),
    },
  },
  education: {
    label: 'Education', q: ['education', 'teacher', 'student', 'teaching', 'learning'],
    tasks: {
      teaching: T('Teaching & learning', /\b(teach\w*|tutor(s|ing)?|students?|lessons?|courses?|quiz\w*|flashcards?|curriculum|homework)\b/i, ['teaching', 'tutor', 'students', 'lesson', 'course', 'quiz', 'flashcards', 'learn']),
    },
  },
  research: {
    label: 'Research', q: ['research', 'researcher', 'academic'],
    tasks: {
      research: T('Research & papers', /\b(research papers?|literature reviews?|arxiv|pubmed|citations?|academic|scholar\w*|deep research|research assistant)\b/i, ['research', 'papers', 'literature review', 'arxiv', 'citations', 'deep research']),
    },
  },
  personal: {
    label: 'Personal productivity', q: ['personal', 'productivity'],
    tasks: {
      productivity: T('Productivity', /\b(productivity|to-?dos?|habits?|journal\w*|personal assistant|time management|pomodoro|daily planning)\b/i, ['productivity', 'todo', 'to do', 'habits', 'journal', 'personal assistant', 'planning']),
    },
  },
};

export const INDUSTRIES = {
  ecommerce: T('E-commerce', /\b(e-?commerce|shopify|woocommerce|online stores?|amazon sellers?|product listings?|bigcommerce)\b/i, ['ecommerce', 'e-commerce', 'shopify', 'online store', 'amazon seller']),
  'real-estate': T('Real estate', /\b(real estate|realtors?|mls|listing agents?|mortgages?|rentals?)\b/i, ['real estate', 'realtor', 'property', 'mortgage', 'rentals']),
  healthcare: T('Healthcare', /\b(health ?care|medical|clinical|patients?|hipaa|fhir|doctors?|hospitals?)\b/i, ['healthcare', 'medical', 'clinical', 'patients', 'doctors']),
  finance: T('Finance & banking', /\b(fintech|banking|banks?|payments?|stripe|lending|insurance)\b/i, ['fintech', 'banking', 'bank', 'payments', 'insurance']),
  media: T('Media & publishing', /\b(journalis\w+|newsrooms?|digital publishing|magazines?|news articles?)\b/i, ['media', 'publishing', 'journalism', 'news']),
  gaming: T('Games', /\b(game dev\w*|games?(?!-chang)|unity|unreal engine|godot|gaming)\b/i, ['game', 'games', 'gaming', 'unity', 'godot', 'game dev']),
  travel: T('Travel & hospitality', /\b(travel|hotels?|flights?|bookings?|hospitality|airbnb)\b/i, ['travel', 'hotel', 'flights', 'hospitality']),
  food: T('Restaurants & food', /\b(restaurants?|restaurant menus?|food|cooking|cooking recipes?)\b/i, ['restaurant', 'food', 'recipes', 'menu']),
  agencies: T('Agencies & freelancers', /\b(agenc(y|ies)|freelanc\w+|client work|client reports?)\b/i, ['agency', 'agencies', 'freelancer', 'clients']),
  saas: T('SaaS & startups', /\b(saas|startups?|founders?|b2b)\b/i, ['saas', 'startup', 'startups', 'founder', 'b2b']),
};

// every task, flattened: key is "team/task"
export const TASKS = Object.fromEntries(Object.entries(TEAMS).flatMap(([team, t]) => Object.entries(t.tasks).map(([k, v]) => [`${team}/${k}`, { ...v, team, key: k }])));

export function classify(name, description) {
  const text = `${name} ${name} ${description || ''}`;
  const tasks = Object.entries(TASKS).filter(([, t]) => t.re.test(text)).map(([k]) => k);
  // "strong": the listing's own name says it (a "security-reviewer"), not just a mention in its description
  const strong = tasks.filter((k) => TASKS[k].re.test(String(name).replace(/[-_]+/g, ' ')));
  const teams = [...new Set(tasks.map((k) => k.split('/')[0]))];
  const industries = Object.entries(INDUSTRIES).filter(([, t]) => t.re.test(text)).map(([k]) => k);
  return { teams, tasks, strong, industries };
}

// what the browser needs to understand a typed query (no regexes shipped, just phrases)
export const clientTaxonomy = () => ({
  teams: Object.fromEntries(Object.entries(TEAMS).map(([k, t]) => [k, { label: t.label, q: t.q }])),
  tasks: Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, { label: t.label, team: t.team, q: t.q }])),
  industries: Object.fromEntries(Object.entries(INDUSTRIES).map(([k, t]) => [k, { label: t.label, q: t.q }])),
});
