<?php

namespace App\Enums;

enum VaultTransactionStatus: string
{
    case Pending = 'pending';
    case Completed = 'completed';
    case Partial = 'partial';
    case Failed = 'failed';
}
