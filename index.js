// node.js bot
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ApplicationCommandOptionType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ComponentType, ChannelType } = require('discord.js');
const axios = require('axios');

// Webhook logging configuration
const WEBHOOK_URL = "https://discord.com/api/webhooks/1375018617271226378"; // Set this in your secrets

class WebhookLogger {
    constructor(webhookUrl) {
        this.webhookUrl = webhookUrl;
    }
    
    async sendLog(level, message) {
        if (!this.webhookUrl) return;
        
        try {
            const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const logMessage = `${timestamp} ${level.toUpperCase()} ${message}`;
            
            // Truncate message if too long for Discord
            let content = logMessage;
            if (content.length > 2000) {
                content = content.substring(0, 1997) + "...";
            }
            
            const payload = {
                content: `\`\`\`\n${content}\n\`\`\``,
                username: "Bot Logger"
            };
            
            await axios.post(this.webhookUrl, payload);
        } catch (error) {
            console.error('Webhook logging error:', error.message);
        }
    }
    
    info(message) {
        console.log(`INFO: ${message}`);
        this.sendLog('info', message);
    }
    
    error(message) {
        console.error(`ERROR: ${message}`);
        this.sendLog('error', message);
    }
    
    warn(message) {
        console.warn(`WARN: ${message}`);
        this.sendLog('warn', message);
    }
}

// Initialize webhook logger
const logger = new WebhookLogger(WEBHOOK_URL);

// Track bot start time for uptime calculation
const botStartTime = Date.now();

// Suggestion counter and settings
let suggestionCounter = 1;

// In-memory settings for suggestion system
const suggestionSettings = {
    enabled: true,
    channel_id: null,
    approved_channel: null,
    rejected_channel: null,
    staff_roles: []
};

// In-memory settings for ticket system
const ticketSettings = {
    enabled: true,
    log_channel: null,
    limit: 5,
    staff_roles: [],
    category_id: null
};

// In-memory settings for autorole system
const autoroleSettings = {
    enabled: false,
    role_id: null
};

// In-memory settings for welcome message system
const welcomeSettings = {
    enabled: false,
    channel: null,
    embed: {
        description: "Welcome to {server}! We're glad to have you here, {user}!",
        thumbnail: true,
        color: "#0099ff",
        footer: "Welcome to our community!",
        image: null
    }
};

// In-memory settings for chatbot system
const chatbotSettings = {
    enabled: false,
    channel_id: null
};

// Pollinations API function
async function callPollinationsAPI(messages) {
    try {
        // Convert conversation to a simple prompt format
        let prompt = messages.map(msg => {
            if (msg.role === 'system') return `System: ${msg.content}`;
            if (msg.role === 'user') return `User: ${msg.content}`;
            if (msg.role === 'assistant') return `Assistant: ${msg.content}`;
            return msg.content;
        }).join('\n');

        const response = await axios.post('https://text.pollinations.ai/', {
            messages: [{ role: 'user', content: prompt }],
            model: 'openai'
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        logger.error(`API Error: ${error.message}`);
        throw error;
    }
}

// Track open tickets
const openTickets = new Map();

// Helper function to check if user has staff permissions
function hasStaffPermissions(member) {
    if (member.permissions.has('ManageGuild')) return true;
    return suggestionSettings.staff_roles.some(roleId => member.roles.cache.has(roleId));
}

// Helper function to check if user has ticket staff permissions
function hasTicketStaffPermissions(member) {
    if (member.permissions.has('ManageGuild')) return true;
    return ticketSettings.staff_roles.some(roleId => member.roles.cache.has(roleId));
}

// Helper function to check if channel is a ticket channel
function isTicketChannel(channel) {
    return channel.name.startsWith('ticket-') || openTickets.has(channel.id);
}

// Helper function to close a ticket
async function closeTicket(channel, user, reason = 'No reason provided') {
    try {
        if (!isTicketChannel(channel)) return 'NOT_TICKET';
        
        // Send closure message
        const closeEmbed = new EmbedBuilder()
            .setTitle('🔒 Ticket Closed')
            .setDescription(`This ticket has been closed by ${user.username}`)
            .addFields({ name: 'Reason', value: reason })
            .setColor(0xff0000)
            .setTimestamp();
        
        await channel.send({ embeds: [closeEmbed] });
        
        // Log to log channel if configured
        if (ticketSettings.log_channel) {
            const logChannel = channel.guild.channels.cache.get(ticketSettings.log_channel);
            if (logChannel) {
                const logEmbed = new EmbedBuilder()
                    .setTitle('📋 Ticket Closed')
                    .setDescription(`Ticket ${channel.name} was closed`)
                    .addFields(
                        { name: 'Channel', value: channel.name, inline: true },
                        { name: 'Closed by', value: user.username, inline: true },
                        { name: 'Reason', value: reason, inline: false }
                    )
                    .setColor(0xff0000)
                    .setTimestamp();
                
                await logChannel.send({ embeds: [logEmbed] });
            }
        }
        
        // Remove from tracking and delete channel after delay
        openTickets.delete(channel.id);
        setTimeout(() => {
            channel.delete().catch(console.error);
        }, 5000);
        
        return 'SUCCESS';
    } catch (error) {
        logger.error(`Error closing ticket: ${error.message}`);
        return 'ERROR';
    }
}

// Helper function to format permissions
function parsePermissions(perms) {
    return perms.map(perm => `• ${perm}`).join('\n');
}

// Helper function to format uptime
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours % 24 > 0) parts.push(`${hours % 24}h`);
    if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
    if (seconds % 60 > 0) parts.push(`${seconds % 60}s`);
    
    return parts.length > 0 ? parts.join(' ') : '0s';
}

// Helper function to validate hex color
function isValidHex(hex) {
    return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(hex);
}

// Helper function to build welcome message
async function buildWelcomeMessage(member) {
    const settings = welcomeSettings.embed;
    
    // Replace placeholders in description
    let description = settings.description
        .replace(/\{user\}/g, `<@${member.user.id}>`)
        .replace(/\{username\}/g, member.user.username)
        .replace(/\{server\}/g, member.guild.name)
        .replace(/\{membercount\}/g, member.guild.memberCount);
    
    const embed = new EmbedBuilder()
        .setTitle(`Welcome to ${member.guild.name}!`)
        .setDescription(description)
        .setColor(settings.color)
        .setTimestamp();
    
    if (settings.thumbnail) {
        embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    }
    
    if (settings.footer) {
        embed.setFooter({ text: settings.footer });
    }
    
    if (settings.image) {
        embed.setImage(settings.image);
    }
    
    return embed;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

// Cooldown system
const cooldowns = new Map();

// Handle chatbot messages
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!chatbotSettings.enabled || !chatbotSettings.channel_id) return;
    if (message.channel.id !== chatbotSettings.channel_id) return;
    if (message.content.startsWith('!') || message.content.startsWith('/')) return;

    let conversationLog = [
        { role: 'system', content: 'You are a friendly chatbot.' },
    ];

    try {
        await message.channel.sendTyping();
        let prevMessages = await message.channel.messages.fetch({ limit: 15 });
        prevMessages.reverse();
        
        prevMessages.forEach((msg) => {
            if (msg.content.startsWith('!') || msg.content.startsWith('/')) return;
            if (msg.author.id !== client.user.id && msg.author.bot) return;
            if (msg.author.id == client.user.id) {
                conversationLog.push({
                    role: 'assistant',
                    content: msg.content,
                    name: msg.author.username
                        .replace(/\s+/g, '_')
                        .replace(/[^\w\s]/gi, ''),
                });
            }

            if (msg.author.id == message.author.id) {
                conversationLog.push({
                    role: 'user',
                    content: msg.content,
                    name: message.author.username
                        .replace(/\s+/g, '_')
                        .replace(/[^\w\s]/gi, ''),
                });
            }
        });

        const result = await callPollinationsAPI(conversationLog);
        
        // Handle different response formats from Pollinations API
        let responseText = '';
        if (typeof result === 'string') {
            responseText = result;
        } else if (result.choices && result.choices[0] && result.choices[0].message) {
            responseText = result.choices[0].message.content;
        } else if (result.message) {
            responseText = result.message;
        } else {
            responseText = 'Sorry, I received an unexpected response format.';
        }

        // Truncate response if it's too long (Discord limit is 2000 characters)
        if (responseText.length > 2000) {
            responseText = responseText.substring(0, 1997) + '...';
        }

        await message.reply(responseText);
        logger.info(`Chatbot responded to ${message.author.tag} in ${message.channel.name}`);
    } catch (error) {
        logger.error(`Chatbot error: ${error.message}`);
        await message.reply('Sorry, I encountered an error while processing your message.');
    }
});

// Handle new member joins for autorole and welcome
client.on('guildMemberAdd', async member => {
    // Handle autorole
    if (autoroleSettings.enabled && autoroleSettings.role_id) {
        try {
            const role = member.guild.roles.cache.get(autoroleSettings.role_id);
            if (!role) {
                logger.warn(`Autorole ${autoroleSettings.role_id} not found in ${member.guild.name}, disabling autorole`);
                autoroleSettings.enabled = false;
                autoroleSettings.role_id = null;
            } else {
                // Check if bot can assign the role
                if (!member.guild.members.me.permissions.has('ManageRoles')) {
                    logger.warn(`Missing ManageRoles permission in ${member.guild.name}, cannot assign autorole`);
                } else if (member.guild.members.me.roles.highest.position <= role.position) {
                    logger.warn(`Role ${role.name} is too high in ${member.guild.name}, cannot assign autorole`);
                } else {
                    await member.roles.add(role);
                    logger.info(`Autorole ${role.name} assigned to ${member.user.tag} in ${member.guild.name}`);
                }
            }
        } catch (error) {
            logger.error(`Failed to assign autorole to ${member.user.tag}: ${error.message}`);
        }
    }
    
    // Handle welcome message
    if (welcomeSettings.enabled && welcomeSettings.channel) {
        try {
            const welcomeChannel = member.guild.channels.cache.get(welcomeSettings.channel);
            if (!welcomeChannel) {
                logger.warn(`Welcome channel ${welcomeSettings.channel} not found in ${member.guild.name}, disabling welcome`);
                welcomeSettings.enabled = false;
                welcomeSettings.channel = null;
                return;
            }
            
            // Check bot permissions
            const botPerms = welcomeChannel.permissionsFor(member.guild.members.me);
            if (!botPerms.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
                logger.warn(`Missing permissions in welcome channel ${welcomeChannel.name}`);
                return;
            }
            
            // Build welcome message
            const welcomeEmbed = await buildWelcomeMessage(member);
            await welcomeChannel.send({ embeds: [welcomeEmbed] });
            logger.info(`Welcome message sent for ${member.user.tag} in ${member.guild.name}`);
            
        } catch (error) {
            logger.error(`Failed to send welcome message for ${member.user.tag}: ${error.message}`);
        }
    }
});

client.once('ready', () => {
    const message = `Logged in as ${client.user.tag}!`;
    console.log(message);
    logger.info(`Bot started: ${message}`);
    
    // Register slash commands
    const stockCommand = new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Check the current stock information');
    
    const botCommand = new SlashCommandBuilder()
        .setName('bot')
        .setDescription('Bot related commands')
        .addSubcommand(subcommand =>
            subcommand
                .setName('invite')
                .setDescription("Get bot's invite link")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stats')
                .setDescription("Get bot's statistics")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('uptime')
                .setDescription("Get bot's uptime")
        );
    
    const infoCommand = new SlashCommandBuilder()
        .setName('info')
        .setDescription('Show various information')
        .addSubcommand(subcommand =>
            subcommand
                .setName('user')
                .setDescription('Get user information')
                .addUserOption(option =>
                    option
                        .setName('name')
                        .setDescription('Name of the user')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Get channel information')
                .addChannelOption(option =>
                    option
                        .setName('name')
                        .setDescription('Name of the channel')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('guild')
                .setDescription('Get guild information')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('avatar')
                .setDescription('Display avatar information')
                .addUserOption(option =>
                    option
                        .setName('name')
                        .setDescription('Name of the user')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('emoji')
                .setDescription('Display emoji information')
                .addStringOption(option =>
                    option
                        .setName('name')
                        .setDescription('Name of the emoji')
                        .setRequired(true)
                )
        );

    const ticketCommand = new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Ticket system management')
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Setup ticket creation message in a channel')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Channel to send ticket creation message')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('close')
                .setDescription('Close the current ticket')
                .addStringOption(option =>
                    option
                        .setName('reason')
                        .setDescription('Reason for closing the ticket')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add a user to the ticket')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to add to the ticket')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a user from the ticket')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to remove from the ticket')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('log')
                .setDescription('Set ticket log channel')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Channel for ticket logs')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        );

    const chatbotCommand = new SlashCommandBuilder()
        .setName('chatbot')
        .setDescription('ChatGPT chatbot management')
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Set the channel for ChatGPT responses')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Channel for ChatGPT responses')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reset')
                .setDescription('Reset the ChatGPT channel to default')
        );

    const autoroleCommand = new SlashCommandBuilder()
        .setName('autorole')
        .setDescription('Setup role to be given when a member joins the server')
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Setup the autorole')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('The role to be given')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName('role_id')
                        .setDescription('The role ID to be given')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Disable the autorole')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List current autorole configuration')
        );

    const welcomeCommand = new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Setup welcome message system')
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Enable or disable welcome message')
                .addStringOption(option =>
                    option
                        .setName('status')
                        .setDescription('Enable or disable')
                        .setRequired(true)
                        .addChoices(
                            { name: 'ON', value: 'ON' },
                            { name: 'OFF', value: 'OFF' }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('preview')
                .setDescription('Preview the configured welcome message')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Set welcome channel')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Channel for welcome messages')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('desc')
                .setDescription('Set embed description')
                .addStringOption(option =>
                    option
                        .setName('content')
                        .setDescription('Description content (use {user}, {username}, {server}, {membercount})')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('thumbnail')
                .setDescription('Configure embed thumbnail')
                .addStringOption(option =>
                    option
                        .setName('status')
                        .setDescription('Show user avatar as thumbnail')
                        .setRequired(true)
                        .addChoices(
                            { name: 'ON', value: 'ON' },
                            { name: 'OFF', value: 'OFF' }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('color')
                .setDescription('Set embed color')
                .addStringOption(option =>
                    option
                        .setName('hex-code')
                        .setDescription('Hex color code (e.g., #ff0000)')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('footer')
                .setDescription('Set embed footer')
                .addStringOption(option =>
                    option
                        .setName('content')
                        .setDescription('Footer content')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('image')
                .setDescription('Set embed image')
                .addStringOption(option =>
                    option
                        .setName('url')
                        .setDescription('Image URL')
                        .setRequired(true)
                )
        );

    const suggestionCommand = new SlashCommandBuilder()
        .setName('suggestion')
        .setDescription('Configure suggestion system or submit suggestions')
        .addSubcommand(subcommand =>
            subcommand
                .setName('submit')
                .setDescription('Submit a suggestion')
                .addStringOption(option =>
                    option
                        .setName('text')
                        .setDescription('Your suggestion')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Enable or disable suggestion system')
                .addStringOption(option =>
                    option
                        .setName('enabled')
                        .setDescription('Enable or disable')
                        .setRequired(true)
                        .addChoices(
                            { name: 'ON', value: 'ON' },
                            { name: 'OFF', value: 'OFF' }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('channel')
                .setDescription('Set suggestion channel')
                .addChannelOption(option =>
                    option
                        .setName('channel_name')
                        .setDescription('Channel for suggestions (leave empty to disable)')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('appch')
                .setDescription('Set approved suggestions channel')
                .addChannelOption(option =>
                    option
                        .setName('channel_name')
                        .setDescription('Channel for approved suggestions')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('rejch')
                .setDescription('Set rejected suggestions channel')
                .addChannelOption(option =>
                    option
                        .setName('channel_name')
                        .setDescription('Channel for rejected suggestions')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('approve')
                .setDescription('Approve a suggestion')
                .addChannelOption(option =>
                    option
                        .setName('channel_name')
                        .setDescription('Channel where the suggestion is')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('message_id')
                        .setDescription('Message ID of the suggestion')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('reason')
                        .setDescription('Reason for approval')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reject')
                .setDescription('Reject a suggestion')
                .addChannelOption(option =>
                    option
                        .setName('channel_name')
                        .setDescription('Channel where the suggestion is')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('message_id')
                        .setDescription('Message ID of the suggestion')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('reason')
                        .setDescription('Reason for rejection')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('staffadd')
                .setDescription('Add a staff role')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('Role to add as staff')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('staffremove')
                .setDescription('Remove a staff role')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('Role to remove from staff')
                        .setRequired(true)
                )
        );
    
    client.application.commands.create(stockCommand);
    client.application.commands.create(botCommand);
    client.application.commands.create(infoCommand);
    client.application.commands.create(autoroleCommand);
    client.application.commands.create(welcomeCommand);
    client.application.commands.create(suggestionCommand);
    client.application.commands.create(ticketCommand);
    client.application.commands.create(chatbotCommand);
    logger.info('Slash commands /stock, /bot, /info, /autorole, /welcome, /suggestion, /ticket, and /chatbot registered successfully');
});

client.on('interactionCreate', async interaction => {
    
    
    // Handle button interactions
    if (interaction.isButton()) {
        // Handle ticket creation
        if (interaction.customId === 'create_ticket') {
            const userId = interaction.user.id;
            const guild = interaction.guild;
            
            // Check if user already has an open ticket
            const existingTicket = Array.from(openTickets.values()).find(ticket => ticket.userId === userId);
            if (existingTicket) {
                return interaction.reply({ 
                    content: `You already have an open ticket: <#${existingTicket.channelId}>`, 
                    ephemeral: true 
                });
            }
            
            // Check ticket limit
            if (openTickets.size >= ticketSettings.limit) {
                return interaction.reply({ 
                    content: 'Maximum number of tickets reached. Please wait for existing tickets to be closed.', 
                    ephemeral: true 
                });
            }
            
            try {
                // Create ticket channel
                const ticketChannel = await guild.channels.create({
                    name: `ticket-${interaction.user.username}`,
                    type: ChannelType.GuildText,
                    parent: ticketSettings.category_id,
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            deny: ['ViewChannel'],
                        },
                        {
                            id: interaction.user.id,
                            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
                        },
                        {
                            id: interaction.client.user.id,
                            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'],
                        }
                    ]
                });
                
                // Add to tracking
                openTickets.set(ticketChannel.id, {
                    userId: userId,
                    channelId: ticketChannel.id,
                    createdAt: Date.now()
                });
                
                // Send welcome message
                const welcomeEmbed = new EmbedBuilder()
                    .setTitle('🎫 Support Ticket')
                    .setDescription(`Hello ${interaction.user}, welcome to your support ticket!\n\nPlease describe your issue and our staff will assist you shortly.`)
                    .setColor(0x00ff00)
                    .setTimestamp();
                
                const closeButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('close_ticket')
                            .setLabel('🔒 Close Ticket')
                            .setStyle(ButtonStyle.Danger)
                    );
                
                await ticketChannel.send({ 
                    content: `<@${interaction.user.id}>`,
                    embeds: [welcomeEmbed], 
                    components: [closeButton] 
                });
                
                await interaction.reply({ 
                    content: `Your ticket has been created: ${ticketChannel}`, 
                    ephemeral: true 
                });
                
                // Log ticket creation
                if (ticketSettings.log_channel) {
                    const logChannel = guild.channels.cache.get(ticketSettings.log_channel);
                    if (logChannel) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle('📋 New Ticket Created')
                            .setDescription(`Ticket created by ${interaction.user.username}`)
                            .addFields(
                                { name: 'User', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'Channel', value: `<#${ticketChannel.id}>`, inline: true }
                            )
                            .setColor(0x00ff00)
                            .setTimestamp();
                        
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                }
                
                logger.info(`Ticket created by ${interaction.user.tag}: ${ticketChannel.name}`);
            } catch (error) {
                logger.error(`Error creating ticket: ${error.message}`);
                await interaction.reply({ 
                    content: 'An error occurred while creating your ticket. Please try again later.', 
                    ephemeral: true 
                });
            }
            return;
        }
        
        // Handle ticket close button
        if (interaction.customId === 'close_ticket') {
            if (!isTicketChannel(interaction.channel)) {
                return interaction.reply({ content: 'This button can only be used in ticket channels!', ephemeral: true });
            }
            
            const result = await closeTicket(interaction.channel, interaction.user, 'Closed via button');
            if (result === 'SUCCESS') {
                await interaction.reply({ content: 'Ticket will be closed in 5 seconds...', ephemeral: true });
            } else {
                await interaction.reply({ content: 'Failed to close ticket.', ephemeral: true });
            }
            return;
        }
        
        const [action, type, suggestionId] = interaction.customId.split('_');
        
        if (action === 'suggestion' && (type === 'upvote' || type === 'downvote')) {
            // Store user votes (in production, you'd want to use a database)
            if (!global.suggestionVotes) {
                global.suggestionVotes = {};
            }
            
            const voteKey = `${suggestionId}_${interaction.user.id}`;
            const currentVote = global.suggestionVotes[voteKey];
            
            // Remove previous vote if clicking same button
            if (currentVote === type) {
                delete global.suggestionVotes[voteKey];
                await interaction.reply({ 
                    content: `Your ${type === 'upvote' ? '👍' : '👎'} vote has been removed!`, 
                    ephemeral: true 
                });
            } else {
                // Update vote
                global.suggestionVotes[voteKey] = type;
                
                await interaction.reply({ 
                    content: `You ${type === 'upvote' ? 'upvoted 👍' : 'downvoted 👎'} this suggestion!`, 
                    ephemeral: true 
                });
            }
            
            // Count votes for this suggestion
            const upvotes = Object.entries(global.suggestionVotes)
                .filter(([key, vote]) => key.startsWith(`${suggestionId}_`) && vote === 'upvote')
                .length;
            
            const downvotes = Object.entries(global.suggestionVotes)
                .filter(([key, vote]) => key.startsWith(`${suggestionId}_`) && vote === 'downvote')
                .length;
            
            // Update button labels with vote counts
            const updatedButtons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`suggestion_upvote_${suggestionId}`)
                        .setLabel(`👍 Upvote (${upvotes})`)
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`suggestion_downvote_${suggestionId}`)
                        .setLabel(`👎 Downvote (${downvotes})`)
                        .setStyle(ButtonStyle.Danger)
                );
            
            // Update the original message with new button labels
            await interaction.message.edit({ 
                embeds: interaction.message.embeds, 
                components: [updatedButtons] 
            });
            
            logger.info(`User ${interaction.user.tag} ${type}d suggestion ${suggestionId} - Upvotes: ${upvotes}, Downvotes: ${downvotes}`);
        }
        return;
    }
    
    if (!interaction.isChatInputCommand()) return;
    
    if (interaction.commandName === 'stock') {
        // Check if command is used in DM
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Cannot use command in DM', ephemeral: true });
        }
        
        // Cooldown check
        const userId = interaction.user.id;
        const now = Date.now();
        const cooldownAmount = 5 * 1000; // 5 seconds
        
        if (cooldowns.has(userId)) {
            const expirationTime = cooldowns.get(userId) + cooldownAmount;
            
            if (now < expirationTime) {
                const timeLeft = Math.ceil((expirationTime - now) / 1000);
                return interaction.reply({ 
                    content: `Please wait ${timeLeft} seconds!`, 
                    ephemeral: true 
                });
            }
        }
        
        cooldowns.set(userId, now);
        
        await interaction.deferReply();
        logger.info(`Stock command used by ${interaction.user.tag} in ${interaction.guild?.name || 'Unknown Guild'}`);
        
        try {
            // Fetch stock data
            const response = await axios.get('https://api.joshlei.com/v2/growagarden/stock');
            const stockData = response.data;
            logger.info('Stock data fetched successfully');
            
            // Create embed
            const embed = new EmbedBuilder()
                .setAuthor({ 
                    name: client.user.username, 
                    iconURL: client.user.displayAvatarURL() 
                })
                .setThumbnail(client.user.displayAvatarURL())
                .setColor(0x0099ff)
                .setTimestamp();
            
            // Add gear stock field
            if (stockData.gear_stock && stockData.gear_stock.length > 0) {
                const gearStock = stockData.gear_stock
                    .slice(0, 11)
                    .map(item => `${item.item_id} x${item.quantity}`)
                    .join('\n');
                embed.addFields({ name: '**GEAR STOCK**', value: gearStock || 'No items', inline: false });
            }
            
            // Add seeds stock field
            if (stockData.seed_stock && stockData.seed_stock.length > 0) {
                const seedStock = stockData.seed_stock
                    .slice(0, 11)
                    .map(item => `${item.item_id} x${item.quantity}`)
                    .join('\n');
                embed.addFields({ name: '**SEEDS STOCK**', value: seedStock || 'No items', inline: false });
            }
            
            // Add egg stock field
            if (stockData.egg_stock && stockData.egg_stock.length > 0) {
                const eggStock = stockData.egg_stock
                    .slice(0, 4)
                    .map(item => `${item.item_id} x${item.quantity}`)
                    .join('\n');
                embed.addFields({ name: '**EGG STOCK**', value: eggStock || 'No items', inline: false });
            }
            
            // Add cosmetics stock field
            if (stockData.cosmetic_stock && stockData.cosmetic_stock.length > 0) {
                const cosmeticStock = stockData.cosmetic_stock
                    .slice(0, 11)
                    .map(item => `${item.item_id} x${item.quantity}`)
                    .join('\n');
                embed.addFields({ name: '**COSMETICS STOCK**', value: cosmeticStock || 'No items', inline: false });
            }
            
            // Add event stock field
            if (stockData.eventshop_stock && stockData.eventshop_stock.length > 0) {
                const eventStock = stockData.eventshop_stock
                    .slice(0, 4)
                    .map(item => `${item.item_id} x${item.quantity}`)
                    .join('\n');
                embed.addFields({ name: '**EVENT STOCK**', value: eventStock || 'No items', inline: false });
            }
            
            await interaction.editReply({ embeds: [embed] });
            
        } catch (error) {
            const errorMessage = `Error fetching stock data for ${interaction.user.tag}: ${error.message}`;
            console.error(errorMessage);
            logger.error(errorMessage);
            await interaction.editReply({ 
                content: '**There was an error! Please try again later**' 
            });
        }
    }
    
    if (interaction.commandName === 'bot') {
        const subcommand = interaction.options.getSubcommand();
        
        switch (subcommand) {
            case 'invite':
                const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=2147485696&scope=bot%20applications.commands`;
                
                const inviteEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle('Bot Invite Link')
                    .setDescription(`[Click here to invite me to your server!](${inviteUrl})`)
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                await interaction.reply({ embeds: [inviteEmbed] });
                logger.info(`Invite command used by ${interaction.user.tag}`);
                break;
                
            case 'stats':
                const guilds = client.guilds.cache.size;
                const users = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
                const uptime = Date.now() - botStartTime;
                const uptimeFormatted = formatUptime(uptime);
                
                const statsEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle('Bot Statistics')
                    .addFields(
                        { name: 'Servers', value: guilds.toString(), inline: true },
                        { name: 'Users', value: users.toString(), inline: true },
                        { name: 'Uptime', value: uptimeFormatted, inline: true }
                    )
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                await interaction.reply({ embeds: [statsEmbed] });
                logger.info(`Stats command used by ${interaction.user.tag}`);
                break;
                
            case 'uptime':
                const currentUptime = Date.now() - botStartTime;
                const formattedUptime = formatUptime(currentUptime);
                
                const uptimeEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle('Bot Uptime')
                    .setDescription(`I've been online for: **${formattedUptime}**`)
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                await interaction.reply({ embeds: [uptimeEmbed] });
                logger.info(`Uptime command used by ${interaction.user.tag}`);
                break;
        }
    }
    
    if (interaction.commandName === 'info') {
        const subcommand = interaction.options.getSubcommand();
        
        switch (subcommand) {
            case 'user':
                const targetUser = interaction.options.getUser('name') || interaction.user;
                const member = interaction.guild?.members.cache.get(targetUser.id);
                
                const userEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle(`User Information: ${targetUser.username}`)
                    .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
                    .addFields(
                        { name: 'Username', value: targetUser.username, inline: true },
                        { name: 'Discriminator', value: targetUser.discriminator || 'None', inline: true },
                        { name: 'ID', value: targetUser.id, inline: true },
                        { name: 'Bot', value: targetUser.bot ? 'Yes' : 'No', inline: true },
                        { name: 'Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:R>`, inline: true }
                    )
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                if (member) {
                    userEmbed.addFields(
                        { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
                        { name: 'Roles', value: member.roles.cache.size > 1 ? `${member.roles.cache.size - 1}` : '0', inline: true }
                    );
                }
                
                await interaction.reply({ embeds: [userEmbed] });
                logger.info(`User info command used by ${interaction.user.tag} for ${targetUser.username}`);
                break;
                
            case 'channel':
                const targetChannel = interaction.options.getChannel('name') || interaction.channel;
                
                const channelEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle(`Channel Information: ${targetChannel.name}`)
                    .addFields(
                        { name: 'Name', value: targetChannel.name, inline: true },
                        { name: 'Type', value: targetChannel.type.toString(), inline: true },
                        { name: 'ID', value: targetChannel.id, inline: true },
                        { name: 'Created', value: `<t:${Math.floor(targetChannel.createdTimestamp / 1000)}:R>`, inline: true }
                    )
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                if (targetChannel.topic) {
                    channelEmbed.addFields({ name: 'Topic', value: targetChannel.topic, inline: false });
                }
                
                await interaction.reply({ embeds: [channelEmbed] });
                logger.info(`Channel info command used by ${interaction.user.tag} for ${targetChannel.name}`);
                break;
                
            case 'guild':
                const guild = interaction.guild;
                
                if (!guild) {
                    return interaction.reply({ content: 'This command can only be used in a server!', ephemeral: true });
                }
                
                const guildEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle(`Guild Information: ${guild.name}`)
                    .setThumbnail(guild.iconURL({ size: 256 }))
                    .addFields(
                        { name: 'Name', value: guild.name, inline: true },
                        { name: 'ID', value: guild.id, inline: true },
                        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                        { name: 'Members', value: guild.memberCount.toString(), inline: true },
                        { name: 'Channels', value: guild.channels.cache.size.toString(), inline: true },
                        { name: 'Roles', value: guild.roles.cache.size.toString(), inline: true },
                        { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
                        { name: 'Verification Level', value: guild.verificationLevel.toString(), inline: true }
                    )
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                if (guild.description) {
                    guildEmbed.addFields({ name: 'Description', value: guild.description, inline: false });
                }
                
                await interaction.reply({ embeds: [guildEmbed] });
                logger.info(`Guild info command used by ${interaction.user.tag} in ${guild.name}`);
                break;
                
            case 'avatar':
                const avatarUser = interaction.options.getUser('name') || interaction.user;
                
                const avatarEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle(`Avatar: ${avatarUser.username}`)
                    .setImage(avatarUser.displayAvatarURL({ size: 512 }))
                    .setDescription(`[Download Avatar](${avatarUser.displayAvatarURL({ size: 1024 })})`)
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                await interaction.reply({ embeds: [avatarEmbed] });
                logger.info(`Avatar command used by ${interaction.user.tag} for ${avatarUser.username}`);
                break;
                
            case 'emoji':
                const emojiName = interaction.options.getString('name');
                const emoji = interaction.guild?.emojis.cache.find(e => e.name === emojiName);
                
                if (!emoji) {
                    return interaction.reply({ content: `Emoji "${emojiName}" not found in this server!`, ephemeral: true });
                }
                
                const emojiEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle(`Emoji Information: ${emoji.name}`)
                    .setThumbnail(emoji.url)
                    .addFields(
                        { name: 'Name', value: emoji.name, inline: true },
                        { name: 'ID', value: emoji.id, inline: true },
                        { name: 'Animated', value: emoji.animated ? 'Yes' : 'No', inline: true },
                        { name: 'Created', value: `<t:${Math.floor(emoji.createdTimestamp / 1000)}:R>`, inline: true },
                        { name: 'URL', value: `[Link](${emoji.url})`, inline: true }
                    )
                    .setDescription(`Usage: \`<:${emoji.name}:${emoji.id}>\``)
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                await interaction.reply({ embeds: [emojiEmbed] });
                logger.info(`Emoji info command used by ${interaction.user.tag} for ${emoji.name}`);
                break;
        }
    }
    
    if (interaction.commandName === 'suggestion') {
        const subcommand = interaction.options.getSubcommand();
        
        switch (subcommand) {
            case 'submit':
                if (!suggestionSettings.enabled) {
                    return interaction.reply({ content: 'Suggestion system is currently disabled!', ephemeral: true });
                }
                
                if (!suggestionSettings.channel_id) {
                    return interaction.reply({ content: 'No suggestion channel has been configured!', ephemeral: true });
                }
                
                const suggestionChannel = interaction.guild.channels.cache.get(suggestionSettings.channel_id);
                if (!suggestionChannel) {
                    return interaction.reply({ content: 'Configured suggestion channel no longer exists!', ephemeral: true });
                }
                
                const suggestion = interaction.options.getString('text');
                const suggestionId = suggestionCounter++;
                
                const suggestionEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle(`📬 New Suggestion (ID: ${suggestionId})`)
                    .setDescription(suggestion)
                    .addFields(
                        { name: 'Author', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Submitted', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
                    )
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                // Create action buttons
                const voteButtons = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`suggestion_upvote_${suggestionId}`)
                            .setLabel('👍 Upvote')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId(`suggestion_downvote_${suggestionId}`)
                            .setLabel('👎 Downvote')
                            .setStyle(ButtonStyle.Danger)
                    );
                
                const message = await suggestionChannel.send({ 
                    embeds: [suggestionEmbed], 
                    components: [voteButtons] 
                });
                
                // Create a thread for the suggestion
                const thread = await message.startThread({
                    name: `Suggestion ${suggestionId} - ${interaction.user.username}`,
                    autoArchiveDuration: 10080, // 7 days
                    reason: `Thread for suggestion ${suggestionId}`
                });
                
                // Add the suggestion author to the thread
                await thread.members.add(interaction.user.id);
                
                // Send a welcome message in the thread
                await thread.send(`**Discussion thread for suggestion ${suggestionId}**\n\nOriginal suggestion by <@${interaction.user.id}>:\n> ${suggestion}\n\nFeel free to discuss this suggestion here! 💬`);
                
                await interaction.reply({ content: `Your suggestion has been submitted to ${suggestionChannel} with a discussion thread created!`, ephemeral: true });
                logger.info(`Suggestion ${suggestionId} submitted by ${interaction.user.tag} with thread created: ${suggestion}`);
                break;
                
            case 'status':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const status = interaction.options.getString('enabled');
                suggestionSettings.enabled = status === 'ON';
                
                await interaction.reply({ 
                    content: `Suggestion system is now ${suggestionSettings.enabled ? 'enabled' : 'disabled'}!`,
                    ephemeral: true 
                });
                logger.info(`Suggestion system ${suggestionSettings.enabled ? 'enabled' : 'disabled'} by ${interaction.user.tag}`);
                break;
                
            case 'channel':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const channel = interaction.options.getChannel('channel_name');
                if (!channel) {
                    suggestionSettings.channel_id = null;
                    await interaction.reply({ content: 'Suggestion channel has been disabled!', ephemeral: true });
                } else {
                    const requiredPerms = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AddReactions', 'ReadMessageHistory'];
                    const botPerms = channel.permissionsFor(interaction.guild.members.me);
                    
                    if (!botPerms.has(requiredPerms)) {
                        return interaction.reply({ 
                            content: `I need the following permissions in ${channel}:\n${parsePermissions(requiredPerms)}`,
                            ephemeral: true 
                        });
                    }
                    
                    suggestionSettings.channel_id = channel.id;
                    await interaction.reply({ content: `Suggestions will now be sent to ${channel}!`, ephemeral: true });
                }
                break;
                
            case 'appch':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const appChannel = interaction.options.getChannel('channel_name');
                if (!appChannel) {
                    suggestionSettings.approved_channel = null;
                    await interaction.reply({ content: 'Approved suggestions channel has been disabled!', ephemeral: true });
                } else {
                    suggestionSettings.approved_channel = appChannel.id;
                    await interaction.reply({ content: `Approved suggestions will now be sent to ${appChannel}!`, ephemeral: true });
                }
                break;
                
            case 'rejch':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const rejChannel = interaction.options.getChannel('channel_name');
                if (!rejChannel) {
                    suggestionSettings.rejected_channel = null;
                    await interaction.reply({ content: 'Rejected suggestions channel has been disabled!', ephemeral: true });
                } else {
                    suggestionSettings.rejected_channel = rejChannel.id;
                    await interaction.reply({ content: `Rejected suggestions will now be sent to ${rejChannel}!`, ephemeral: true });
                }
                break;
                
            case 'approve':
                if (!hasStaffPermissions(interaction.member)) {
                    return interaction.reply({ content: 'You need staff permissions to approve suggestions!', ephemeral: true });
                }
                
                const approveChannel = interaction.options.getChannel('channel_name');
                const approveMessageId = interaction.options.getString('message_id');
                const approveReason = interaction.options.getString('reason') || 'No reason provided';
                
                try {
                    const message = await approveChannel.messages.fetch(approveMessageId);
                    const embed = message.embeds[0];
                    
                    if (!embed || !embed.title?.includes('New Suggestion')) {
                        return interaction.reply({ content: 'That message is not a valid suggestion!', ephemeral: true });
                    }
                    
                    const approvedEmbed = new EmbedBuilder()
                        .setAuthor({ 
                            name: client.user.username, 
                            iconURL: client.user.displayAvatarURL() 
                        })
                        .setTitle(`✅ ${embed.title.replace('📬 New', 'Approved')}`)
                        .setDescription(embed.description)
                        .addFields(
                            ...embed.fields,
                            { name: 'Status', value: '✅ Approved', inline: true },
                            { name: 'Approved by', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Reason', value: approveReason, inline: false }
                        )
                        .setColor(0x00ff00)
                        .setTimestamp();
                    
                    await message.edit({ embeds: [approvedEmbed] });
                    
                    if (suggestionSettings.approved_channel) {
                        const approvedChannel = interaction.guild.channels.cache.get(suggestionSettings.approved_channel);
                        if (approvedChannel) {
                            await approvedChannel.send({ embeds: [approvedEmbed] });
                        }
                    }
                    
                    await interaction.reply({ content: 'Suggestion approved successfully!', ephemeral: true });
                    logger.info(`Suggestion approved by ${interaction.user.tag}: ${approveMessageId}`);
                } catch (error) {
                    await interaction.reply({ content: 'Could not find that message!', ephemeral: true });
                }
                break;
                
            case 'reject':
                if (!hasStaffPermissions(interaction.member)) {
                    return interaction.reply({ content: 'You need staff permissions to reject suggestions!', ephemeral: true });
                }
                
                const rejectChannel = interaction.options.getChannel('channel_name');
                const rejectMessageId = interaction.options.getString('message_id');
                const rejectReason = interaction.options.getString('reason') || 'No reason provided';
                
                try {
                    const message = await rejectChannel.messages.fetch(rejectMessageId);
                    const embed = message.embeds[0];
                    
                    if (!embed || !embed.title?.includes('New Suggestion')) {
                        return interaction.reply({ content: 'That message is not a valid suggestion!', ephemeral: true });
                    }
                    
                    const rejectedEmbed = new EmbedBuilder()
                        .setAuthor({ 
                            name: client.user.username, 
                            iconURL: client.user.displayAvatarURL() 
                        })
                        .setTitle(`❌ ${embed.title.replace('📬 New', 'Rejected')}`)
                        .setDescription(embed.description)
                        .addFields(
                            ...embed.fields,
                            { name: 'Status', value: '❌ Rejected', inline: true },
                            { name: 'Rejected by', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Reason', value: rejectReason, inline: false }
                        )
                        .setColor(0xff0000)
                        .setTimestamp();
                    
                    await message.edit({ embeds: [rejectedEmbed] });
                    
                    if (suggestionSettings.rejected_channel) {
                        const rejectedChannel = interaction.guild.channels.cache.get(suggestionSettings.rejected_channel);
                        if (rejectedChannel) {
                            await rejectedChannel.send({ embeds: [rejectedEmbed] });
                        }
                    }
                    
                    await interaction.reply({ content: 'Suggestion rejected successfully!', ephemeral: true });
                    logger.info(`Suggestion rejected by ${interaction.user.tag}: ${rejectMessageId}`);
                } catch (error) {
                    await interaction.reply({ content: 'Could not find that message!', ephemeral: true });
                }
                break;
                
            case 'staffadd':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const addRole = interaction.options.getRole('role');
                if (suggestionSettings.staff_roles.includes(addRole.id)) {
                    return interaction.reply({ content: `\`${addRole.name}\` is already a staff role!`, ephemeral: true });
                }
                
                suggestionSettings.staff_roles.push(addRole.id);
                await interaction.reply({ content: `\`${addRole.name}\` is now a staff role!`, ephemeral: true });
                logger.info(`Staff role added by ${interaction.user.tag}: ${addRole.name}`);
                break;
                
            case 'staffremove':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const removeRole = interaction.options.getRole('role');
                if (!suggestionSettings.staff_roles.includes(removeRole.id)) {
                    return interaction.reply({ content: `\`${removeRole.name}\` is not a staff role!`, ephemeral: true });
                }
                
                suggestionSettings.staff_roles = suggestionSettings.staff_roles.filter(id => id !== removeRole.id);
                await interaction.reply({ content: `\`${removeRole.name}\` is no longer a staff role!`, ephemeral: true });
                logger.info(`Staff role removed by ${interaction.user.tag}: ${removeRole.name}`);
                break;
        }
    }
    
    if (interaction.commandName === 'welcome') {
        const subcommand = interaction.options.getSubcommand();
        
        switch (subcommand) {
            case 'status':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const status = interaction.options.getString('status');
                welcomeSettings.enabled = status === 'ON';
                
                await interaction.reply({ 
                    content: `Welcome message system is now ${welcomeSettings.enabled ? 'enabled' : 'disabled'}!`,
                    ephemeral: true 
                });
                logger.info(`Welcome system ${welcomeSettings.enabled ? 'enabled' : 'disabled'} by ${interaction.user.tag}`);
                break;
                
            case 'preview':
                if (!welcomeSettings.enabled) {
                    return interaction.reply({ content: 'Welcome message system is not enabled!', ephemeral: true });
                }
                
                if (!welcomeSettings.channel) {
                    return interaction.reply({ content: 'No welcome channel has been configured!', ephemeral: true });
                }
                
                const targetChannel = interaction.guild.channels.cache.get(welcomeSettings.channel);
                if (!targetChannel) {
                    return interaction.reply({ content: 'Configured welcome channel no longer exists!', ephemeral: true });
                }
                
                try {
                    const previewEmbed = await buildWelcomeMessage(interaction.member);
                    await targetChannel.send({ embeds: [previewEmbed] });
                    await interaction.reply({ content: `Welcome preview sent to ${targetChannel}!`, ephemeral: true });
                    logger.info(`Welcome preview sent by ${interaction.user.tag}`);
                } catch (error) {
                    await interaction.reply({ content: 'Failed to send preview message!', ephemeral: true });
                }
                break;
                
            case 'channel':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const channel = interaction.options.getChannel('channel');
                const botPerms = channel.permissionsFor(interaction.guild.members.me);
                
                if (!botPerms.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
                    return interaction.reply({ 
                        content: `I need permissions to view, send messages, and embed links in ${channel}!`,
                        ephemeral: true 
                    });
                }
                
                welcomeSettings.channel = channel.id;
                await interaction.reply({ content: `Welcome messages will now be sent to ${channel}!`, ephemeral: true });
                logger.info(`Welcome channel set to ${channel.name} by ${interaction.user.tag}`);
                break;
                
            case 'desc':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const description = interaction.options.getString('content');
                welcomeSettings.embed.description = description;
                await interaction.reply({ 
                    content: 'Welcome message description updated!\n\nAvailable placeholders:\n• `{user}` - Mentions the user\n• `{username}` - User\'s username\n• `{server}` - Server name\n• `{membercount}` - Total member count',
                    ephemeral: true 
                });
                break;
                
            case 'thumbnail':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const thumbnailStatus = interaction.options.getString('status');
                welcomeSettings.embed.thumbnail = thumbnailStatus === 'ON';
                await interaction.reply({ 
                    content: `Welcome message thumbnail ${welcomeSettings.embed.thumbnail ? 'enabled' : 'disabled'}!`,
                    ephemeral: true 
                });
                break;
                
            case 'color':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const color = interaction.options.getString('hex-code');
                if (!isValidHex(color)) {
                    return interaction.reply({ content: 'Invalid hex color! Please use format like #ff0000', ephemeral: true });
                }
                
                welcomeSettings.embed.color = color;
                await interaction.reply({ content: `Welcome message color updated to ${color}!`, ephemeral: true });
                break;
                
            case 'footer':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const footer = interaction.options.getString('content');
                welcomeSettings.embed.footer = footer;
                await interaction.reply({ content: 'Welcome message footer updated!', ephemeral: true });
                break;
                
            case 'image':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const imageUrl = interaction.options.getString('url');
                // Basic URL validation
                try {
                    new URL(imageUrl);
                    welcomeSettings.embed.image = imageUrl;
                    await interaction.reply({ content: 'Welcome message image updated!', ephemeral: true });
                } catch {
                    await interaction.reply({ content: 'Invalid URL provided!', ephemeral: true });
                }
                break;
        }
    }
    
    if (interaction.commandName === 'autorole') {
        const subcommand = interaction.options.getSubcommand();
        
        switch (subcommand) {
            case 'add':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                let role = interaction.options.getRole('role');
                if (!role) {
                    const roleId = interaction.options.getString('role_id');
                    if (!roleId) {
                        return interaction.reply({ content: 'Please provide a role or role ID!', ephemeral: true });
                    }
                    
                    role = interaction.guild.roles.cache.get(roleId);
                    if (!role) {
                        return interaction.reply({ content: 'No role found with that ID!', ephemeral: true });
                    }
                }
                
                // Validation checks
                if (role.id === interaction.guild.roles.everyone.id) {
                    return interaction.reply({ content: 'You cannot set `@everyone` as the autorole!', ephemeral: true });
                }
                
                if (!interaction.guild.members.me.permissions.has('ManageRoles')) {
                    return interaction.reply({ content: 'I don\'t have the `ManageRoles` permission!', ephemeral: true });
                }
                
                if (interaction.guild.members.me.roles.highest.position <= role.position) {
                    return interaction.reply({ content: 'I don\'t have the permissions to assign this role! The role must be below my highest role.', ephemeral: true });
                }
                
                if (role.managed) {
                    return interaction.reply({ content: 'Oops! This role is managed by an integration and cannot be assigned!', ephemeral: true });
                }
                
                autoroleSettings.enabled = true;
                autoroleSettings.role_id = role.id;
                
                await interaction.reply({ 
                    content: `✅ Autorole has been set to **${role.name}**! New members will automatically receive this role.`, 
                    ephemeral: true 
                });
                logger.info(`Autorole set to ${role.name} by ${interaction.user.tag}`);
                break;
                
            case 'remove':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                autoroleSettings.enabled = false;
                autoroleSettings.role_id = null;
                
                await interaction.reply({ 
                    content: '✅ Autorole has been disabled!', 
                    ephemeral: true 
                });
                logger.info(`Autorole disabled by ${interaction.user.tag}`);
                break;
                
            case 'list':
                if (!autoroleSettings.enabled || !autoroleSettings.role_id) {
                    return interaction.reply({ content: 'Autorole is currently disabled.', ephemeral: true });
                }
                
                const autorole = interaction.guild.roles.cache.get(autoroleSettings.role_id);
                if (!autorole) {
                    autoroleSettings.enabled = false;
                    autoroleSettings.role_id = null;
                    return interaction.reply({ content: 'The configured autorole no longer exists. Autorole has been disabled.', ephemeral: true });
                }
                
                const autoroleEmbed = new EmbedBuilder()
                    .setAuthor({ 
                        name: client.user.username, 
                        iconURL: client.user.displayAvatarURL() 
                    })
                    .setTitle('🤖 Autorole Configuration')
                    .addFields(
                        { name: 'Status', value: autoroleSettings.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
                        { name: 'Role', value: `${autorole}`, inline: true },
                        { name: 'Role ID', value: autorole.id, inline: true }
                    )
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                await interaction.reply({ embeds: [autoroleEmbed], ephemeral: true });
                break;
        }
    }
    
    if (interaction.commandName === 'ticket') {
        const subcommand = interaction.options.getSubcommand();
        
        switch (subcommand) {
            case 'setup':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                if (!interaction.guild.members.me.permissions.has('ManageChannels')) {
                    return interaction.reply({ content: 'I need `Manage Channels` permission to create ticket channels!', ephemeral: true });
                }
                
                const setupChannel = interaction.options.getChannel('channel');
                
                // Check bot permissions in the channel
                const botPerms = setupChannel.permissionsFor(interaction.guild.members.me);
                if (!botPerms.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
                    return interaction.reply({ 
                        content: `I need permissions to view, send messages, and embed links in ${setupChannel}!`, 
                        ephemeral: true 
                    });
                }
                
                // Create the ticket setup embed and button
                const embed = new EmbedBuilder()
                    .setTitle('🎫 Support Ticket')
                    .setDescription('Need help? Click the button below to create a support ticket!\n\nOur staff will assist you as soon as possible.')
                    .setFooter({ text: 'You can only have 1 open ticket at a time!' })
                    .setColor(0x0099ff)
                    .setTimestamp();
                
                const ticketButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('create_ticket')
                            .setLabel('🎫 Open Ticket')
                            .setStyle(ButtonStyle.Success)
                    );
                
                try {
                    await setupChannel.send({ embeds: [embed], components: [ticketButton] });
                    await interaction.reply({ 
                        content: `✅ Ticket system has been successfully set up in ${setupChannel}!`, 
                        ephemeral: true 
                    });
                    logger.info(`Ticket system set up in ${setupChannel.name} by ${interaction.user.tag}`);
                } catch (error) {
                    logger.error(`Error setting up ticket system: ${error.message}`);
                    await interaction.reply({ 
                        content: 'Failed to set up ticket system. Please check my permissions and try again.', 
                        ephemeral: true 
                    });
                }
                break;
                
            case 'close':
                if (!isTicketChannel(interaction.channel)) {
                    return interaction.reply({ content: 'This command can only be used in ticket channels!', ephemeral: true });
                }
                
                const reason = interaction.options.getString('reason') || 'No reason provided';
                const result = await closeTicket(interaction.channel, interaction.user, reason);
                
                if (result === 'SUCCESS') {
                    await interaction.reply({ content: 'Ticket will be closed in 5 seconds...' });
                } else {
                    await interaction.reply({ content: 'Failed to close ticket.', ephemeral: true });
                }
                break;
                
            case 'add':
                if (!isTicketChannel(interaction.channel)) {
                    return interaction.reply({ content: 'This command can only be used in ticket channels!', ephemeral: true });
                }
                
                if (!hasTicketStaffPermissions(interaction.member)) {
                    return interaction.reply({ content: 'You need staff permissions to add users to tickets!', ephemeral: true });
                }
                
                const userToAdd = interaction.options.getUser('user');
                
                try {
                    await interaction.channel.permissionOverwrites.create(userToAdd.id, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    });
                    
                    await interaction.reply({ content: `Added ${userToAdd} to the ticket!` });
                    logger.info(`User ${userToAdd.tag} added to ticket ${interaction.channel.name} by ${interaction.user.tag}`);
                } catch (error) {
                    await interaction.reply({ content: 'Failed to add user to ticket.', ephemeral: true });
                }
                break;
                
            case 'remove':
                if (!isTicketChannel(interaction.channel)) {
                    return interaction.reply({ content: 'This command can only be used in ticket channels!', ephemeral: true });
                }
                
                if (!hasTicketStaffPermissions(interaction.member)) {
                    return interaction.reply({ content: 'You need staff permissions to remove users from tickets!', ephemeral: true });
                }
                
                const userToRemove = interaction.options.getUser('user');
                
                try {
                    await interaction.channel.permissionOverwrites.create(userToRemove.id, {
                        ViewChannel: false,
                        SendMessages: false,
                        ReadMessageHistory: false
                    });
                    
                    await interaction.reply({ content: `Removed ${userToRemove} from the ticket!` });
                    logger.info(`User ${userToRemove.tag} removed from ticket ${interaction.channel.name} by ${interaction.user.tag}`);
                } catch (error) {
                    await interaction.reply({ content: 'Failed to remove user from ticket.', ephemeral: true });
                }
                break;
                
            case 'log':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const logChannel = interaction.options.getChannel('channel');
                
                if (!logChannel.permissionsFor(interaction.guild.members.me).has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
                    return interaction.reply({ 
                        content: `I need permissions to view, send messages, and embed links in ${logChannel}!`, 
                        ephemeral: true 
                    });
                }
                
                ticketSettings.log_channel = logChannel.id;
                await interaction.reply({ content: `Ticket logs will now be sent to ${logChannel}!`, ephemeral: true });
                logger.info(`Ticket log channel set to ${logChannel.name} by ${interaction.user.tag}`);
                break;
        }
    }
    
    if (interaction.commandName === 'chatbot') {
        const subcommand = interaction.options.getSubcommand();
        
        switch (subcommand) {
            case 'channel':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                const channel = interaction.options.getChannel('channel');
                
                // Check bot permissions in the channel
                const botPerms = channel.permissionsFor(interaction.guild.members.me);
                if (!botPerms.has(['ViewChannel', 'SendMessages', 'ReadMessageHistory'])) {
                    return interaction.reply({ 
                        content: `I need permissions to view, send messages, and read message history in ${channel}!`, 
                        ephemeral: true 
                    });
                }
                
                chatbotSettings.enabled = true;
                chatbotSettings.channel_id = channel.id;
                
                await interaction.reply({ 
                    content: `✅ ChatGPT responses will now be active in ${channel}! Users can chat naturally and I'll respond.`, 
                    ephemeral: true 
                });
                logger.info(`Chatbot channel set to ${channel.name} by ${interaction.user.tag}`);
                break;
                
            case 'reset':
                if (!interaction.member.permissions.has('ManageGuild')) {
                    return interaction.reply({ content: 'You need `Manage Guild` permission to use this command!', ephemeral: true });
                }
                
                chatbotSettings.enabled = false;
                chatbotSettings.channel_id = null;
                
                await interaction.reply({ 
                    content: '✅ ChatGPT channel has been reset. The chatbot is now disabled.', 
                    ephemeral: true 
                });
                logger.info(`Chatbot reset by ${interaction.user.tag}`);
                break;
        }
    }
});

// Login with bot token
client.login("PUT BOT TOKEN")
    .catch(error => {
        const errorMessage = `Failed to login: ${error.message}`;
        console.error(errorMessage);
        logger.error(errorMessage);
    });

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    const errorMessage = `Unhandled Rejection at: ${promise}, reason: ${reason}`;
    console.error(errorMessage);
    logger.error(errorMessage);
});

process.on('uncaughtException', (error) => {
    const errorMessage = `Uncaught Exception: ${error.message}`;
    console.error(errorMessage);
    logger.error(errorMessage);
    process.exit(1);
});
