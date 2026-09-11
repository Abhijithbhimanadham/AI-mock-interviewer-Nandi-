const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const { PDFParse } = require("pdf-parse");

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PROFILE_CHARS = 40000;
const MAX_ANSWER_CHARS = 12000;
const MAX_MESSAGES = 81;

const CATEGORIES = [
  "introduction",
  "project",
  "technical",
  "behavioral",
  "debugging",
  "architecture",
  "closing"
];

const DIFFICULTIES = [
  "beginner",
  "intermediate",
  "advanced"
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function extractGithubUsername(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);

    if (
      url.protocol !== "https:" ||
      !["github.com", "www.github.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      parts.length !== 1 ||
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(parts[0])
    ) {
      throw new Error();
    }

    return parts[0];
  } catch {
    throw new HttpError(
      400,
      "Enter a GitHub profile URL such as https://github.com/your-username."
    );
  }
}

async function getGithubProfile(githubUrl, fetchImpl = fetch) {
  const username = extractGithubUsername(githubUrl);

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "offline-ai-interviewer"
  };

  async function get(endpoint) {
    let response;

    try {
      response = await fetchImpl(`https://api.github.com${endpoint}`, {
        headers,
        signal: AbortSignal.timeout(12000),
        redirect: "error"
      });
    } catch {
      throw new HttpError(
        502,
        "GitHub could not be reached. Try again or upload a TXT/PDF resume."
      );
    }

    if (response.status === 404) {
      throw new HttpError(400, "That public GitHub profile was not found.");
    }

    if ([403, 429].includes(response.status)) {
      throw new HttpError(
        503,
        "GitHub temporarily blocked or rate-limited this request. Try again later."
      );
    }

    if (!response.ok) {
      throw new HttpError(502, "GitHub could not return this profile.");
    }

    return response.json();
  }

  const user = await get(`/users/${encodeURIComponent(username)}`);
  const repositories = await get(
    `/users/${encodeURIComponent(username)}/repos?type=owner&sort=pushed&per_page=10`
  );

  if (!Array.isArray(repositories)) {
    throw new HttpError(502, "GitHub returned an unexpected repository response.");
  }

  return {
    source: "github",
    username: user.login,
    name: user.name,
    bio: user.bio,
    profileUrl: user.html_url,
    publicRepositories: user.public_repos,
    repositories: repositories.map((repository) => ({
      name: repository.name,
      description: repository.description,
      language: repository.language,
      url: repository.html_url,
      topics: repository.topics || [],
      fork: repository.fork
    }))
  };
}

async function extractResumeText(file) {
  const extension = path.extname(file.originalname).toLowerCase();

  if (extension === ".txt") {
    try {
      const text = new TextDecoder("utf-8", {
        fatal: true
      }).decode(file.buffer);

      if (text.includes("\0")) {
        throw new Error();
      }

      return text;
    } catch {
      throw new HttpError(
        400,
        "The TXT resume must contain valid UTF-8 text."
      );
    }
  }

  if (!file.buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new HttpError(
      400,
      "The uploaded file does not appear to be a PDF."
    );
  }

  const parser = new PDFParse({
    data: file.buffer
  });

  try {
    const info = await parser.getInfo();

    if (info.total > 30) {
      throw new HttpError(
        400,
        "Please upload a resume with at most 30 pages."
      );
    }

    const result = await parser.getText();

    return result.pages
      .map((page) => page.text)
      .join("\n\n");
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(
      400,
      "The PDF could not be read. Use a text-based PDF or TXT resume."
    );
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function getProfileText(profile) {
  if (!profile) {
    return "";
  }

  if (profile.source === "resume") {
    return profile.resumeText || "";
  }

  const repositories = Array.isArray(profile.repositories)
    ? profile.repositories
    : [];

  return [
    profile.name,
    profile.username,
    profile.bio,
    ...repositories.flatMap((repository) => [
      repository.name,
      repository.description,
      repository.language,
      ...(repository.topics || [])
    ])
  ]
    .filter(Boolean)
    .join(" ");
}

function getCandidateName(profile) {
  if (profile.name) {
    return profile.name.split(/\s+/)[0];
  }

  if (profile.username) {
    return profile.username;
  }

  if (profile.filename) {
    return profile.filename.replace(/\.[^/.]+$/, "");
  }

  return "there";
}

function findSkills(profile) {
  const skillNames = [
    "javascript",
    "typescript",
    "react",
    "node.js",
    "node",
    "express",
    "python",
    "java",
    "c#",
    "c++",
    "go",
    "rust",
    "sql",
    "postgresql",
    "mysql",
    "mongodb",
    "docker",
    "kubernetes",
    "aws",
    "azure",
    "git",
    "github",
    "websocket",
    "graphql",
    "rest",
    "api",
    "testing",
    "jest",
    "redis"
  ];

  const text = getProfileText(profile).toLowerCase();

  return skillNames.filter((skill) => text.includes(skill));
}

function findProjects(profile) {
  if (profile.source === "github") {
    return (profile.repositories || [])
      .filter((repository) => !repository.fork)
      .slice(0, 5)
      .map((repository) => repository.name)
      .filter(Boolean);
  }

  const text = profile.resumeText || "";
  const projectSection = text.match(
    /projects?:([\s\S]*?)(?:experience|education|skills|$)/i
  );

  if (!projectSection) {
    return [];
  }

  return projectSection[1]
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((line) => line.length > 4)
    .slice(0, 5);
}

function chooseQuestion({ profile, conversation, answer }) {
  const questionNumber = Math.floor(conversation.length / 2);
  const skills = findSkills(profile);
  const projects = findProjects(profile);
  const primarySkill = skills[0] || "your technical skills";
  const primaryProject = projects[0] || "one of your projects";
  const answerText = (answer || "").toLowerCase();

  if (questionNumber === 0) {
    return {
      message: `Hi ${getCandidateName(profile)}. I will ask you practical interview questions based on your background.`,
      question: projects.length
        ? `Could you briefly explain ${primaryProject}, your role in it, and the main result you achieved?`
        : "Could you briefly introduce yourself and describe the type of software work you enjoy most?",
      category: projects.length ? "project" : "introduction",
      difficulty: "beginner"
    };
  }

  if (questionNumber === 1) {
    return {
      message: "Thank you. I would like to understand your technical decisions.",
      question: `Why did you choose ${primarySkill} for that work, and what alternatives did you consider?`,
      category: "technical",
      difficulty: "intermediate"
    };
  }

  if (questionNumber === 2) {
    return {
      message: "That gives useful context. Let us look at reliability.",
      question: `If ${primaryProject} started responding slowly in production, how would you investigate and fix the problem?`,
      category: "debugging",
      difficulty: "intermediate"
    };
  }

  if (questionNumber === 3) {
    return {
      message: "Good. Now let us discuss quality and maintainability.",
      question: `What tests would you write for ${primaryProject}, and how would those tests help you change the code safely?`,
      category: "technical",
      difficulty: "intermediate"
    };
  }

  if (questionNumber === 4) {
    return {
      message: "Let us move from implementation to system design.",
      question: `How would you design ${primaryProject} to support ten times more users while keeping it reliable?`,
      category: "architecture",
      difficulty: "advanced"
    };
  }

  if (questionNumber === 5) {
    return {
      message: "I want to explore how you work with other people.",
      question: "Tell me about a time you disagreed with a technical decision. What did you do, and what was the outcome?",
      category: "behavioral",
      difficulty: "intermediate"
    };
  }

  if (
    answerText.includes("not sure") ||
    answerText.includes("don't know") ||
    answerText.length < 30
  ) {
    return {
      message: "That answer is a useful starting point. I would like one concrete example.",
      question: "Can you describe a specific situation, the action you took, and the result?",
      category: "behavioral",
      difficulty: "beginner"
    };
  }

  if (questionNumber >= 8) {
    return {
      message: "You have covered technical decisions, problem solving, and collaboration.",
      question: "What area would you most like to improve during your next six months as a software engineer?",
      category: "closing",
      difficulty: "intermediate"
    };
  }

  return {
    message: "Thank you. Let us go one level deeper.",
    question: `What was the hardest part of your answer, and how would you improve that approach in a future project using ${primarySkill}?`,
    category: "technical",
    difficulty: "advanced"
  };
}

function createLocalInterviewer({ profile, conversation }) {
  const lastMessage = conversation[conversation.length - 1];
  const answer = lastMessage?.role === "user"
    ? lastMessage.content
    : "";

  return chooseQuestion({
    profile,
    conversation,
    answer
  });
}

function validateAnswerBody(body) {
  const { profile, conversation, answer } = body || {};

  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    !["resume", "github"].includes(profile.source) ||
    JSON.stringify(profile).length > MAX_PROFILE_CHARS
  ) {
    throw new HttpError(
      400,
      "Missing or invalid profile. Restart the interview."
    );
  }

  if (
    !Array.isArray(conversation) ||
    !conversation.length ||
    conversation.length > MAX_MESSAGES
  ) {
    throw new HttpError(
      400,
      "Missing or overly long interview history. Restart the interview."
    );
  }

  let totalCharacters = 0;

  const cleanConversation = conversation.map((message, index) => {
    const expectedRole = index % 2 === 0 ? "assistant" : "user";

    if (
      !message ||
      message.role !== expectedRole ||
      typeof message.content !== "string" ||
      !message.content.trim() ||
      message.content.length > MAX_ANSWER_CHARS
    ) {
      throw new HttpError(
        400,
        "Invalid interview history. Restart the interview."
      );
    }

    totalCharacters += message.content.length;

    return {
      role: expectedRole,
      content: message.content
    };
  });

  if (
    conversation.length % 2 !== 1 ||
    totalCharacters > 180000
  ) {
    throw new HttpError(
      400,
      "Invalid or overly long interview history. Restart the interview."
    );
  }

  if (
    typeof answer !== "string" ||
    !answer.trim() ||
    answer.length > MAX_ANSWER_CHARS
  ) {
    throw new HttpError(
      400,
      "Provide a spoken answer of at most 12,000 characters."
    );
  }

  return {
    profile,
    conversation: cleanConversation,
    answer: answer.trim()
  };
}

function createApp({ githubFetch = fetch, rateLimitMax = 60 } = {}) {
  const app = express();

  app.disable("x-powered-by");

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_FILE_BYTES,
      files: 1,
      fields: 1,
      fieldSize: 2048,
      parts: 2
    },
    fileFilter(req, file, callback) {
      const extension = path.extname(file.originalname).toLowerCase();

      const allowedMimes =
        extension === ".pdf"
          ? ["application/pdf", "application/octet-stream"]
          : extension === ".txt"
            ? ["text/plain", "application/octet-stream"]
            : [];

      if (!allowedMimes.includes(file.mimetype)) {
        return callback(
          new HttpError(400, "Only PDF and TXT resumes are supported.")
        );
      }

      callback(null, true);
    }
  });

  app.use("/api", (req, res, next) => {
    const origin = req.get("origin");
    const expectedOrigin = `${req.protocol}://${req.get("host")}`;

    if (origin && origin !== expectedOrigin) {
      return res.status(403).json({
        error: "Cross-origin API requests are not allowed."
      });
    }

    next();
  });

  app.use(
    "/api",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: rateLimitMax,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: "Too many requests. Wait a few minutes before trying again."
      }
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      mode: "offline-rule-based"
    });
  });

  app.post("/api/start", upload.single("resume"), async (req, res) => {
    const rawUrl = req.body?.githubUrl;

    if (rawUrl !== undefined && typeof rawUrl !== "string") {
      throw new HttpError(400, "Invalid GitHub URL field.");
    }

    const githubUrl = (rawUrl || "").trim();

    if (Boolean(githubUrl) === Boolean(req.file)) {
      throw new HttpError(
        400,
        "Provide exactly one source: a GitHub profile URL or a resume."
      );
    }

    let profile;

    if (githubUrl) {
      profile = await getGithubProfile(githubUrl, githubFetch);
    } else {
      const text = await extractResumeText(req.file);

      if (!text.trim()) {
        throw new HttpError(
          400,
          "The resume has no readable text."
        );
      }

      profile = {
        source: "resume",
        filename: req.file.originalname,
        resumeText: text.slice(0, 30000)
      };
    }

    const interviewer = createLocalInterviewer({
      profile,
      conversation: []
    });

    res.json({
      profile,
      interviewer,
      conversation: [
        {
          role: "assistant",
          content: `${interviewer.message}\n\n${interviewer.question}`
        }
      ]
    });
  });

  app.post("/api/answer", async (req, res) => {
    const {
      profile,
      conversation,
      answer
    } = validateAnswerBody(req.body);

    const updatedConversation = [
      ...conversation,
      {
        role: "user",
        content: answer
      }
    ];

    const interviewer = createLocalInterviewer({
      profile,
      conversation: updatedConversation
    });

    res.json({
      interviewer,
      conversation: [
        ...updatedConversation,
        {
          role: "assistant",
          content: `${interviewer.message}\n\n${interviewer.question}`
        }
      ]
    });
  });

  app.use("/api", (req, res) => {
    res.status(404).json({
      error: "API endpoint not found."
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error instanceof multer.MulterError) {
      return res.status(
        error.code === "LIMIT_FILE_SIZE" ? 413 : 400
      ).json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "Resume size must not exceed 5 MB."
            : "Invalid upload. Choose one PDF/TXT resume and no extra fields."
      });
    }

    if (error instanceof HttpError) {
      return res.status(error.status).json({
        error: error.message
      });
    }

    if (error.type === "entity.too.large") {
      return res.status(413).json({
        error: "Request is too large. Restart the interview with shorter answers."
      });
    }

    if (error.type === "entity.parse.failed") {
      return res.status(400).json({
        error: "Invalid JSON request."
      });
    }

    console.error("Request failed:", error.name || "Error");

    res.status(500).json({
      error: "The server could not complete this request."
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";

  createApp().listen(port, host, () => {
    console.log(`Offline AI Interviewer: http://${host}:${port}`);
    console.log("No hosted AI service or API key is required.");
  });
}

module.exports = {
  createApp,
  extractGithubUsername,
  extractResumeText,
  createLocalInterviewer,
  validateAnswerBody
};