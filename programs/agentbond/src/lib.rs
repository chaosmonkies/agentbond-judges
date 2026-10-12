use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("FPymWjwqaqmXQ3ozKNRdBP9FNyWqQcE5TepHvUBgMB1U");

#[program]
pub mod agentbond {
    use super::*;
    pub fn create_job(
        ctx: Context<CreateJob>,
        id: u64,
        amount: u64,
        verifier: Pubkey,
        spec_hash: [u8; 32],
        acceptance_hash: [u8; 32],
        claim_deadline: i64,
        submit_deadline: i64,
        verify_deadline: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, BondError::InvalidAmount);
        require!(
            ctx.accounts.mint.freeze_authority.is_none(),
            BondError::FreezeAuthorityUnsupported
        );
        require!(
            now < claim_deadline
                && claim_deadline < submit_deadline
                && submit_deadline < verify_deadline,
            BondError::InvalidDeadlines
        );
        require!(
            verifier != Pubkey::default() && verifier != ctx.accounts.creator.key(),
            BondError::InvalidVerifier
        );
        require!(
            spec_hash != [0; 32] && acceptance_hash != [0; 32],
            BondError::InvalidHash
        );
        let j = &mut ctx.accounts.job;
        j.id = id;
        j.creator = ctx.accounts.creator.key();
        j.worker = Pubkey::default();
        j.verifier = verifier;
        j.mint = ctx.accounts.mint.key();
        j.token_program = ctx.accounts.token_program.key();
        j.vault = ctx.accounts.vault.key();
        j.bump = ctx.bumps.job;
        j.vault_bump = ctx.bumps.vault;
        j.amount = amount;
        j.spec_hash = spec_hash;
        j.acceptance_hash = acceptance_hash;
        j.created_at = now;
        j.claim_deadline = claim_deadline;
        j.submit_deadline = submit_deadline;
        j.verify_deadline = verify_deadline;
        j.status = JobStatus::Created;
        emit_change(j, now);
        Ok(())
    }
    pub fn fund_job(ctx: Context<FundJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let j = &mut ctx.accounts.job;
        require!(j.status == JobStatus::Created, BondError::InvalidState);
        require!(now < j.claim_deadline, BondError::DeadlinePassed);
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            j.amount,
            ctx.accounts.mint.decimals,
        )?;
        j.status = JobStatus::Funded;
        j.funded_at = now;
        emit_change(j, now);
        Ok(())
    }
    pub fn claim_job(ctx: Context<ClaimJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let j = &mut ctx.accounts.job;
        require!(j.status == JobStatus::Funded, BondError::InvalidState);
        require!(now < j.claim_deadline, BondError::DeadlinePassed);
        require!(
            ctx.accounts.worker.key() != j.creator && ctx.accounts.worker.key() != j.verifier,
            BondError::RoleConflict
        );
        j.worker = ctx.accounts.worker.key();
        j.claimed_at = now;
        j.status = JobStatus::Claimed;
        emit_change(j, now);
        Ok(())
    }
    pub fn submit_work(ctx: Context<SubmitWork>, artifact_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let j = &mut ctx.accounts.job;
        require!(j.status == JobStatus::Claimed, BondError::InvalidState);
        require!(now < j.submit_deadline, BondError::DeadlinePassed);
        require!(artifact_hash != [0; 32], BondError::InvalidHash);
        j.artifact_hash = artifact_hash;
        j.submitted_at = now;
        j.status = JobStatus::Submitted;
        emit_change(j, now);
        Ok(())
    }
    pub fn approve_work(ctx: Context<VerifyWork>, verification_hash: [u8; 32]) -> Result<()> {
        verify(
            &mut ctx.accounts.job,
            verification_hash,
            JobStatus::Verified,
        )
    }
    pub fn reject_work(ctx: Context<VerifyWork>, verification_hash: [u8; 32]) -> Result<()> {
        verify(
            &mut ctx.accounts.job,
            verification_hash,
            JobStatus::Rejected,
        )
    }
    pub fn settle_job(ctx: Context<SettleJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.job.status == JobStatus::Verified,
            BondError::InvalidState
        );
        payout(
            &ctx.accounts.job,
            &ctx.accounts.vault,
            &ctx.accounts.destination,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;
        let j = &mut ctx.accounts.job;
        j.status = JobStatus::Settled;
        j.settled_at = now;
        emit_change(j, now);
        Ok(())
    }
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        let j = &mut ctx.accounts.job;
        require!(j.status == JobStatus::Created, BondError::InvalidState);
        j.status = JobStatus::Cancelled;
        emit_change(j, Clock::get()?.unix_timestamp);
        Ok(())
    }
    pub fn refund_job(ctx: Context<RefundJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let j = &ctx.accounts.job;
        let eligible = match j.status {
            JobStatus::Rejected => true,
            JobStatus::Funded => now >= j.claim_deadline,
            JobStatus::Claimed => now >= j.submit_deadline,
            JobStatus::Submitted => now >= j.verify_deadline,
            _ => false,
        };
        require!(eligible, BondError::RefundUnavailable);
        payout(
            j,
            &ctx.accounts.vault,
            &ctx.accounts.destination,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;
        let j = &mut ctx.accounts.job;
        j.status = JobStatus::Refunded;
        j.settled_at = now;
        emit_change(j, now);
        Ok(())
    }
}

fn verify(job: &mut Account<Job>, hash: [u8; 32], status: JobStatus) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(job.status == JobStatus::Submitted, BondError::InvalidState);
    require!(now < job.verify_deadline, BondError::DeadlinePassed);
    require!(hash != [0; 32], BondError::InvalidHash);
    job.verification_hash = hash;
    job.verified_at = now;
    job.status = status;
    emit_change(job, now);
    Ok(())
}
fn payout<'info>(
    job: &Account<'info, Job>,
    vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    program: &Program<'info, Token>,
) -> Result<()> {
    let id = job.id.to_le_bytes();
    let bump = [job.bump];
    let seeds: &[&[u8]] = &[b"job", job.creator.as_ref(), &id, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                to: destination.to_account_info(),
                mint: mint.to_account_info(),
                authority: job.to_account_info(),
            },
            &[seeds],
        ),
        job.amount,
        mint.decimals,
    )
}
fn emit_change(job: &Account<Job>, timestamp: i64) {
    emit!(JobChanged {
        job: job.key(),
        status: job.status,
        timestamp
    });
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateJob<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 8 + Job::INIT_SPACE, seeds = [b"job", creator.key().as_ref(), &id.to_le_bytes()], bump)]
    pub job: Account<'info, Job>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = creator, seeds = [b"vault", job.key().as_ref()], bump, token::mint = mint, token::authority = job)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct FundJob<'info> {
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"job", job.creator.as_ref(), &job.id.to_le_bytes()], bump = job.bump, has_one = creator, has_one = mint, has_one = vault, has_one = token_program)]
    pub job: Account<'info, Job>,
    #[account(mut, token::mint = mint, token::authority = creator)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump = job.vault_bump, token::mint = mint, token::authority = job)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct ClaimJob<'info> {
    pub worker: Signer<'info>,
    #[account(mut, seeds = [b"job", job.creator.as_ref(), &job.id.to_le_bytes()], bump = job.bump)]
    pub job: Account<'info, Job>,
}
#[derive(Accounts)]
pub struct SubmitWork<'info> {
    pub worker: Signer<'info>,
    #[account(mut, seeds = [b"job", job.creator.as_ref(), &job.id.to_le_bytes()], bump = job.bump, has_one = worker)]
    pub job: Account<'info, Job>,
}
#[derive(Accounts)]
pub struct VerifyWork<'info> {
    pub verifier: Signer<'info>,
    #[account(mut, seeds = [b"job", job.creator.as_ref(), &job.id.to_le_bytes()], bump = job.bump, has_one = verifier)]
    pub job: Account<'info, Job>,
}
#[derive(Accounts)]
pub struct SettleJob<'info> {
    #[account(mut, seeds = [b"job", job.creator.as_ref(), &job.id.to_le_bytes()], bump = job.bump, has_one = mint, has_one = vault, has_one = token_program)]
    pub job: Account<'info, Job>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump = job.vault_bump, token::mint = mint, token::authority = job)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, constraint = destination.owner == job.worker @ BondError::WrongDestination)]
    pub destination: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct CancelJob<'info> {
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"job", job.creator.as_ref(), &job.id.to_le_bytes()], bump = job.bump, has_one = creator)]
    pub job: Account<'info, Job>,
}
#[derive(Accounts)]
pub struct RefundJob<'info> {
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"job", job.creator.as_ref(), &job.id.to_le_bytes()], bump = job.bump, has_one = creator, has_one = mint, has_one = vault, has_one = token_program)]
    pub job: Account<'info, Job>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump = job.vault_bump, token::mint = mint, token::authority = job)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = creator)]
    pub destination: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}
#[account]
#[derive(InitSpace)]
pub struct Job {
    pub id: u64,
    pub creator: Pubkey,
    pub worker: Pubkey,
    pub verifier: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub vault: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    pub amount: u64,
    pub spec_hash: [u8; 32],
    pub acceptance_hash: [u8; 32],
    pub artifact_hash: [u8; 32],
    pub verification_hash: [u8; 32],
    pub created_at: i64,
    pub funded_at: i64,
    pub claimed_at: i64,
    pub submitted_at: i64,
    pub verified_at: i64,
    pub settled_at: i64,
    pub claim_deadline: i64,
    pub submit_deadline: i64,
    pub verify_deadline: i64,
    pub status: JobStatus,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum JobStatus {
    Created,
    Funded,
    Claimed,
    Submitted,
    Verified,
    Rejected,
    Settled,
    Cancelled,
    Refunded,
}
#[event]
pub struct JobChanged {
    pub job: Pubkey,
    pub status: JobStatus,
    pub timestamp: i64,
}
#[error_code]
pub enum BondError {
    #[msg("Escrow mint must have no freeze authority")]
    FreezeAuthorityUnsupported,
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Deadlines must be future and strictly ordered")]
    InvalidDeadlines,
    #[msg("Verifier must be distinct and nonzero")]
    InvalidVerifier,
    #[msg("Hash must be nonzero")]
    InvalidHash,
    #[msg("Invalid lifecycle transition")]
    InvalidState,
    #[msg("Action deadline passed")]
    DeadlinePassed,
    #[msg("Worker must differ from creator and verifier")]
    RoleConflict,
    #[msg("Destination must belong to assigned worker")]
    WrongDestination,
    #[msg("Only rejected or expired unapproved jobs may refund")]
    RefundUnavailable,
}
