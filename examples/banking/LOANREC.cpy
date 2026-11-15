      *----------------------------------------------------------------
      * LOANREC : AMORTIZING LOAN EXCHANGE AREA (TABLE LOANS)
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       01  LOAN-REC.
           05  LOAN-NUMBER         PIC X(10).
      *    BORROWED PRINCIPAL
           05  LOAN-PRINCIPAL      PIC 9(9)V99   COMP-3.
      *    ANNUAL RATE AS A PERCENTAGE
           05  LOAN-ANNUAL-RATE    PIC 9(2)V9(4) COMP-3.
      *    DURATION IN MONTHS
           05  LOAN-MONTHS         PIC 9(3).
      *    BORROWER INSURANCE TAKEN : Y / N
           05  LOAN-INSURANCE      PIC X.
           05  LOAN-INS-PREMIUM    PIC 9(5)V99   COMP-3.
      *    COMPUTED MONTHLY PAYMENT (OUTPUT)
           05  LOAN-PAYMENT        PIC 9(7)V99   COMP-3.
           05  LOAN-RETURN-CODE    PIC X(2).
