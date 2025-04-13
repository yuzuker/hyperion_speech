// Imports and Environment Setup
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const OpenAI = require('openai');
require('dotenv').config();
const axios = require('axios');

// OpenAI and Assistant Configuration
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    defaultHeaders: { 'OpenAI-Beta': 'assistants=v2' }
});

const assistant_id = process.env.OPENAI_ASSISTANT_ID;
const specialUserId = '280896984691245057';
const unrestrictedChannelId = process.env.UNRESTRICTED_CHANNEL_ID;
const restrictedChannelId = process.env.RESTRICTED_CHANNEL_ID;
let threadMap = {}; // To store thread IDs by channel

// Discord Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Register Slash Command: /ask
async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('ask')
            .setDescription('Ask the assistant a question.')
            .addStringOption(option =>
                option.setName('question')
                    .setDescription('The question or content you want to ask')
                    .setRequired(true)
            )
            .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Started refreshing application (/) commands.');

        // Clear all global commands
        const globalCommands = await rest.get(Routes.applicationCommands(client.user.id));
        for (const command of globalCommands) {
            await rest.delete(Routes.applicationCommand(client.user.id, command.id));
            console.log(`Deleted global command: ${command.name}`);
        }

        // Clear all guild commands for a given guild (replace with your guild ID)
        const guildId = '1259995583188570132'; // Replace this with your actual guild ID
        const guildCommands = await rest.get(Routes.applicationGuildCommands(client.user.id, guildId));
        for (const command of guildCommands) {
            await rest.delete(Routes.applicationGuildCommand(client.user.id, guildId, command.id));
            console.log(`Deleted guild command: ${command.name}`);
        }

        // Register guild-specific commands
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, guildId),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands for guild.');

    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Handle the /ask Command
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'ask') {
        const content = interaction.options.getString('question');
        const isSpecialUser = interaction.user.id === specialUserId;

        // Defer the reply to prevent interaction timeout
        await interaction.deferReply();

        try {
            // Handle the ask command with OpenAI and stream the response
            await handleAskCommand(content, interaction, isSpecialUser);
        } catch (error) {
            console.error('Error handling ask command:', error);
            await interaction.editReply("Sorry, something went wrong.");
        }
    }
});

// Handle the /ask command logic with interval-based updates
async function handleAskCommand(content, interaction, isSpecialUser) {
    try {
        console.log('Handling /ask command with content:', content);

        const channelId = interaction.channel.id;
        let assistantToUse = assistant_id;

        if (restrictedChannelId.includes(channelId)) {
            console.log('Restricted channel detected.');
            assistantToUse = assistant_id;
        } else if (unrestrictedChannelId.includes(channelId)) {
            console.log('Unrestricted channel detected.');
            assistantToUse = 'asst_DBGDykdggLUvUMwQNfNLV7u3';
        } else {
            await interaction.editReply("This bot is not allowed to process the /ask command in this channel.");
            console.log(`/ask command not allowed in channel ${channelId}.`);
            return;
        }

        if (!threadMap[channelId]) {
            const newThread = await openai.beta.threads.create();
            threadMap[channelId] = newThread.id;
            console.log(`New thread created for channel ${channelId}: ${newThread.id}`);
        }

        await openai.beta.threads.messages.create(threadMap[channelId], {
            role: 'user',
            content: content
        });

        const run = openai.beta.threads.runs.stream(threadMap[channelId], {
            assistant_id: assistantToUse
        });

        let fullResponse = '';
        let previousResponses = [];
        await interaction.editReply('Hyperion(Beta) is thinking...');

        const updateInterval = setInterval(async () => {
            if (fullResponse.trim()) {
                try {
                    const cleanedResponse = cleanCitations(fullResponse.trim());

                    previousResponses.push(cleanedResponse);
                    if (previousResponses.length > 3) {
                        previousResponses.shift(); // Keep only the last 3 responses
                    }

                    // Stop updating if the last 3 responses are identical
                    if (
                        previousResponses[0] === previousResponses[1] &&
                        previousResponses[1] === previousResponses[2]
                    ) {
                        console.log('Same response detected for 3 consecutive intervals, stopping updates.');
                        clearInterval(updateInterval);
                        return;
                    }

                    // Update the message with the latest response
                    await interaction.editReply(cleanedResponse);
                    console.log('Updated message on Discord:', cleanedResponse);
                } catch (error) {
                    console.error('Error updating Discord message:', error);
                }
            }
        }, 2000); // Update every 2 seconds (adjust as needed)

        run.on('textDelta', (textDelta) => {
            const newContent = textDelta.value || '';
            if (newContent.trim()) {
                fullResponse += newContent;
                console.log('Received textDelta:', newContent);
            }
        });

        run.on('done', async () => {
            clearInterval(updateInterval);
            if (fullResponse.trim()) {
                const cleanedResponse = cleanCitations(fullResponse.trim());
                await interaction.editReply(cleanedResponse);
                console.log('Final response sent to Discord:', cleanedResponse);
            } else {
                await interaction.editReply('Sorry, I have no answer for that.');
                console.log('No answer available.');
            }
        });

        run.on('error', async (error) => {
            clearInterval(updateInterval);
            console.error('Error getting response from the assistant:', error);
            await interaction.editReply('Sorry, something went wrong.');
        });

    } catch (error) {
        console.error('Error in handleAskCommand:', error);
        await interaction.editReply('Sorry, something went wrong.');
    }
}

// Clean up citations from responses
function cleanCitations(text) {
    let cleanedText = text.replace(/【\d+:\d+†source】/g, '');
    cleanedText = cleanedText
        .replace(/(\d+\.)/g, '\n$1') // Add line breaks before numbered points
        .replace(/(Tips|Strategies|Consider|Goals|Defense)/g, '\n\n$1'); // Add space before important sections

    return cleanedText.trim();
}

// Register commands once the bot is ready
client.once('ready', async () => {
    console.log('Bot is ready!');
    await registerCommands();
});

// Log in to Discord with the bot token
client.login(process.env.DISCORD_TOKEN);
