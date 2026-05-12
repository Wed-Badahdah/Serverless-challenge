// test email deploy
const nodemailer = require("nodemailer");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

const crypto = require("crypto");

// DynamoDB
const client = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(client);

// -----------------------------------------------------
// CORS HEADERS
// -----------------------------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin":
    "http://wed-poll-app.s3-website.eu-north-1.amazonaws.com",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

// -----------------------------------------------------
// 1. CREATE POLL
// -----------------------------------------------------
exports.createPoll = async (event) => {
  try {
    const body = JSON.parse(event.body);

    const { question, options } = body;

    if (
      !question ||
      !options ||
      !Array.isArray(options) ||
      options.length < 2
    ) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          message: "يجب توفير سؤال وخيارين على الأقل",
        }),
      };
    }

    const pollId = crypto.randomUUID();

    const newPoll = {
      id: pollId,
      question,
      options: options.map((opt) => ({
        name: opt,
        votes: 0,
      })),
      createdAt: new Date().toISOString(),
    };

    await dynamoDb.send(
      new PutCommand({
        TableName: process.env.POLLS_TABLE,
        Item: newPoll,
      })
    );

    return {
      statusCode: 201,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "تم إنشاء التصويت بنجاح",
        poll: newPoll,
      }),
    };
  } catch (error) {
    console.error("Error creating poll:", error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "حدث خطأ داخلي",
      }),
    };
  }
};

// -----------------------------------------------------
// 2. SUBMIT VOTE
// -----------------------------------------------------
exports.submitVote = async (event) => {
  try {
    const pollId = event.pathParameters.id;

    const body = JSON.parse(event.body);

    const { optionIndex } = body;

    if (
      optionIndex === undefined ||
      typeof optionIndex !== "number"
    ) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          message: "يجب تحديد رقم الخيار الصحيح",
        }),
      };
    }

    const result = await dynamoDb.send(
      new UpdateCommand({
        TableName: process.env.POLLS_TABLE,
        Key: { id: pollId },

        UpdateExpression: `
          SET options[${optionIndex}].votes =
          options[${optionIndex}].votes + :inc
        `,

        ExpressionAttributeValues: {
          ":inc": 1,
        },

        ReturnValues: "ALL_NEW",
      })
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "تم تسجيل التصويت",
        poll: result.Attributes,
      }),
    };
  } catch (error) {
    console.error("Error submitting vote:", error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "حدث خطأ أثناء التصويت",
      }),
    };
  }
};

// -----------------------------------------------------
// 3. GET POLL
// -----------------------------------------------------
exports.getPoll = async (event) => {
  try {
    const pollId = event.pathParameters.id;

    const result = await dynamoDb.send(
      new GetCommand({
        TableName: process.env.POLLS_TABLE,
        Key: { id: pollId },
      })
    );

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          message: "التصويت غير موجود",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(result.Item),
    };
  } catch (error) {
    console.error("Error fetching poll:", error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "حدث خطأ أثناء جلب التصويت",
      }),
    };
  }
};

// -----------------------------------------------------
// 4. SEND RESULTS EMAIL
// -----------------------------------------------------
exports.sendResults = async (event) => {
  try {
    const pollId = event.pathParameters.id;

    const body = JSON.parse(event.body);

    const { targetEmail } = body;

    if (!targetEmail) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          message: "يجب توفير البريد الإلكتروني",
        }),
      };
    }

    const pollData = await dynamoDb.send(
      new GetCommand({
        TableName: process.env.POLLS_TABLE,
        Key: { id: pollId },
      })
    );

    if (!pollData.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          message: "التصويت غير موجود",
        }),
      };
    }

    const poll = pollData.Item;

    const totalVotes = poll.options.reduce(
      (sum, opt) => sum + opt.votes,
      0
    );

    let emailText = `📊 نتائج التصويت\n\n`;

    emailText += `السؤال: ${poll.question}\n`;
    emailText += `إجمالي الأصوات: ${totalVotes}\n\n`;

    poll.options.forEach((opt) => {
      emailText += `- ${opt.name}: ${opt.votes} صوت\n`;
    });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: '"نظام التصويت الآلي" <' + process.env.SMTP_USER + '>',
      to: targetEmail,
      subject: `نتائج التصويت: ${poll.question}`,
      text: emailText,
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "تم إرسال النتائج",
      }),
    };
  } catch (error) {
    console.error("Error sending email:", error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "حدث خطأ أثناء إرسال الإيميل",
      }),
    };
  }
};

// -----------------------------------------------------
// 5. LIST POLLS
// -----------------------------------------------------
exports.listPolls = async () => {
  try {
    const result = await dynamoDb.send(
      new ScanCommand({
        TableName: process.env.POLLS_TABLE,
      })
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(result.Items || []),
    };
  } catch (error) {
    console.error("Error listing polls:", error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "حدث خطأ أثناء جلب التصويتات",
      }),
    };
  }
};